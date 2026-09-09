#!/usr/bin/env node
/**
 * gavel — scripts/seed.mjs
 *
 * The seeder. Deploys and drives the Safe cast that makes every branch of the
 * mechanism demoable on demand. Disclosed in the README: these Safes are ours, and
 * the payouts they queue are ours. That disclosure is the point — M1 is *mechanism*
 * volume and is labelled as such, never summed with M4's third-party demand volume.
 *
 * Subcommands
 *   status              read-only. Balances, deploy state, roster. Spends nothing.
 *   predict             compute the 12 CREATE2 addresses without deploying. Spends nothing.
 *   deploy              deploy any Safe in the manifest that is not yet on-chain.
 *   fund                move USDC from O1 into each Safe per the manifest.
 *   stage               propose + sign a payout to threshold, and STOP. Never executes.
 *                       --hostile <variant> stages a queue shaped to force ONE named
 *                       refusal instead of the drainable happy path. See HOSTILE below.
 *   recycle             move drained USDC from PAYEE back to O1, closing the loop.
 *   govern              SPENDS GAS. Executes a Safe config change that invalidates an
 *                       already-signed payout, producing threshold-drift or owner-removed.
 *
 * Usage
 *   node scripts/seed.mjs status  --chain 11155111
 *   node scripts/seed.mjs predict --chain 11155111
 *   node scripts/seed.mjs deploy  --chain 11155111 [--only HERO_A,VOL_1] [--yes]
 *   node scripts/seed.mjs fund    --chain 11155111 [--yes]
 *   node scripts/seed.mjs recycle --chain 11155111 [--amount 5.0] [--yes]
 *   node scripts/seed.mjs stage   --chain 11155111 --safe VOL_2 --hostile below-threshold --yes
 *
 * Keys never enter this tree. They are parsed out of ~/.config/gavel/seed.txt,
 * which is `cast wallet new-mnemonic` output — a human-readable block, NOT
 * KEY=value, so it must be parsed and must never be `source`d.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, getContract, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import protocolKit from '@safe-global/protocol-kit';
import SafeApiKit from '@safe-global/api-kit';

// @safe-global/protocol-kit ships CJS with an ESM interop shim, so the class lands
// one level deeper than the documented `import Safe from ...`. Unwrap defensively
// rather than pinning to one shape — a patch release that fixes the interop must
// not break this script.
const Safe = protocolKit?.default?.init ? protocolKit.default
           : protocolKit?.init        ? protocolKit
           : null;
if (!Safe) throw new Error('protocol-kit: could not locate the Safe class export');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8'));
const SEED_FILE = join(homedir(), '.config', 'gavel', 'seed.txt');

/** Roles in derivation order, m/44'/60'/0'/0/{0..6} — matches specs/cast.md. */
const ROLES = ['O1', 'O2', 'O3', 'O4', 'O5', 'PAYEE', 'ATTACKER'];

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

/* ------------------------------------------------------------------ keys */

/**
 * Parse `cast wallet new-mnemonic --accounts 7` output into role -> {address, pk}.
 * Reads only; never writes, never logs a key.
 */
function loadCast() {
  let raw;
  try {
    raw = readFileSync(SEED_FILE, 'utf8');
  } catch {
    die(`cannot read ${SEED_FILE}\nGenerate it with:\n  umask 077 && cast wallet new-mnemonic --words 12 --accounts 7 > ${SEED_FILE} && chmod 600 ${SEED_FILE}`);
  }
  const addresses = [...raw.matchAll(/^Address:\s+(0x[0-9a-fA-F]{40})\s*$/gm)].map((m) => m[1]);
  const keys = [...raw.matchAll(/^Private key:\s+(0x[0-9a-fA-F]{64})\s*$/gm)].map((m) => m[1]);
  if (addresses.length < ROLES.length || keys.length < ROLES.length) {
    die(`${SEED_FILE} holds ${addresses.length} accounts; ${ROLES.length} are required (O1..O5, PAYEE, ATTACKER).`);
  }
  const cast = {};
  ROLES.forEach((role, i) => {
    const account = privateKeyToAccount(keys[i]);
    // The file's own address line must agree with the key. A mismatch means the
    // file was hand-edited or truncated, and we refuse rather than sign with a
    // key whose identity we cannot confirm.
    if (account.address.toLowerCase() !== addresses[i].toLowerCase()) {
      die(`${role}: key #${i + 1} derives ${account.address} but the file says ${addresses[i]}.`);
    }
    // `pk` is held in memory for protocol-kit, which takes a signer key rather than
    // a viem account. It is never logged, never written, and never leaves this process.
    cast[role] = { address: account.address, account, pk: keys[i] };
  });
  return cast;
}

/** The Safe Transaction Service API key. Single-value file, read not sourced. */
function loadSafeApiKey() {
  const path = join(homedir(), '.config', 'gavel', 'safe-api-key');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    die(`cannot read ${path}\nGet a JWT from https://developer.safe.global then:\n  umask 077 && pbpaste | tr -d '[:space:]' > ${path} && chmod 600 ${path}`);
  }
}

/* --------------------------------------------------------------- helpers */

function die(msg) {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const cmd = argv[2];
  const flags = {};
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return { cmd, flags };
}

function resolveChain(flags) {
  const id = String(flags.chain ?? '');
  const chain = MANIFEST.chains[id];
  if (!chain) {
    die(`--chain must be one of: ${Object.keys(MANIFEST.chains).join(', ')}\n` +
        `  8453      Base mainnet    (judged — real value, real evidence)\n` +
        `  11155111  Ethereum Sepolia (rehearsal — never enters receipts.json)`);
  }
  return { id: Number(id), ...chain };
}

function selectSafes(flags) {
  if (!flags.only || flags.only === true) return MANIFEST.safes;
  const want = String(flags.only).split(',').map((s) => s.trim());
  const picked = MANIFEST.safes.filter((s) => want.includes(s.id));
  const missing = want.filter((w) => !MANIFEST.safes.some((s) => s.id === w));
  if (missing.length) die(`unknown safe id(s): ${missing.join(', ')}`);
  return picked;
}

const fundAmount = (safe, chain) => safe[chain.fundKey] ?? '0.000000';

/** Build a protocol-kit instance for a manifest entry, in predicted (undeployed) mode. */
function predictedKit(safe, chain, cast, signerPk) {
  return Safe.init({
    provider: chain.rpc,
    signer: signerPk,
    predictedSafe: {
      safeAccountConfig: {
        owners: safe.owners.map((o) => cast[o].address),
        threshold: safe.threshold,
      },
      safeDeploymentConfig: { saltNonce: safe.saltNonce },
    },
  });
}

/* -------------------------------------------------------------- commands */

async function cmdPredict(chain, cast, flags) {
  const pk = process.env.GAVEL_SIGNER_PK; // not required for address prediction
  console.log(`\n  ${chain.name} (${chain.id}) — predicted CREATE2 addresses\n`);
  console.log(`  ${'SAFE'.padEnd(14)}${'THRESHOLD'.padEnd(11)}${'ADDRESS'.padEnd(44)}ROSTER`);
  const out = [];
  for (const safe of selectSafes(flags)) {
    const kit = await predictedKit(safe, chain, cast, pk);
    const address = await kit.getAddress();
    out.push({ id: safe.id, address });
    const th = `${safe.threshold}-of-${safe.owners.length}`;
    console.log(`  ${safe.id.padEnd(14)}${th.padEnd(11)}${address.padEnd(44)}${safe.roster ? 'yes' : 'no'}`);
  }
  console.log(`\n  ${out.length} addresses. Deterministic: same mnemonic + same salts => same addresses on every chain.\n`);
  return out;
}

async function cmdStatus(chain, cast, flags) {
  const client = createPublicClient({ transport: http(chain.rpc) });
  const usdc = getContract({ address: chain.usdc, abi: ERC20_ABI, client });

  console.log(`\n  ${chain.name} (${chain.id}) — role: ${chain.role}`);
  if (!chain.receiptsEligible) {
    console.log(`  NOTE  receiptsEligible=false — nothing here may enter receipts.json or EVIDENCE.md.`);
  }

  console.log(`\n  ACCOUNTS`);
  console.log(`  ${'ROLE'.padEnd(10)}${'ADDRESS'.padEnd(44)}${'ETH'.padEnd(14)}USDC`);
  for (const role of ROLES) {
    const a = cast[role].address;
    const [wei, bal] = await Promise.all([
      client.getBalance({ address: a }),
      usdc.read.balanceOf([a]).catch(() => 0n),
    ]);
    console.log(`  ${role.padEnd(10)}${a.padEnd(44)}${Number(formatUnits(wei, 18)).toFixed(6).padEnd(14)}${formatUnits(bal, 6)}`);
  }

  console.log(`\n  SAFES`);
  console.log(`  ${'SAFE'.padEnd(14)}${'ADDRESS'.padEnd(44)}${'DEPLOYED'.padEnd(10)}${'USDC'.padEnd(12)}WANT`);
  let deployed = 0;
  for (const safe of selectSafes(flags)) {
    const kit = await predictedKit(safe, chain, cast, undefined);
    const address = await kit.getAddress();
    const [code, bal] = await Promise.all([
      client.getCode({ address }).catch(() => undefined),
      usdc.read.balanceOf([address]).catch(() => 0n),
    ]);
    const isDeployed = !!code && code !== '0x';
    if (isDeployed) deployed++;
    console.log(`  ${safe.id.padEnd(14)}${address.padEnd(44)}${(isDeployed ? 'yes' : 'no').padEnd(10)}${formatUnits(bal, 6).padEnd(12)}${fundAmount(safe, chain)}`);
  }
  console.log(`\n  ${deployed}/${selectSafes(flags).length} deployed\n`);
}

async function cmdDeploy(chain, cast, flags) {
  const signer = cast.O1;                       // O1 pays for deploys (seed-data.md §6.1)
  const client = createPublicClient({ transport: http(chain.rpc) });
  const wallet = createWalletClient({ account: signer.account, transport: http(chain.rpc) });

  const pending = [];
  for (const safe of selectSafes(flags)) {
    const kit = await predictedKit(safe, chain, cast, undefined);
    const address = await kit.getAddress();
    const code = await client.getCode({ address }).catch(() => undefined);
    if (code && code !== '0x') continue;        // idempotent: skip what already exists
    pending.push({ safe, address, kit });
  }

  if (!pending.length) { console.log(`\n  nothing to deploy — all selected Safes already exist.\n`); return; }

  console.log(`\n  ${chain.name} (${chain.id}) — about to deploy ${pending.length} Safe(s), paid by O1 ${signer.address}\n`);
  for (const p of pending) console.log(`    ${p.safe.id.padEnd(14)} ${p.address}`);
  if (!flags.yes) { console.log(`\n  Dry run. Re-run with --yes to broadcast.\n`); return; }

  for (const { safe, address, kit } of pending) {
    const tx = await kit.createSafeDeploymentTransaction();
    const hash = await wallet.sendTransaction({
      to: tx.to, data: tx.data, value: BigInt(tx.value || 0), chain: null,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`  ${receipt.status === 'success' ? 'OK  ' : 'FAIL'} ${safe.id.padEnd(14)} ${address}  ${chain.explorer}/tx/${hash}`);
  }
  console.log();
}

async function cmdFund(chain, cast, flags) {
  const signer = cast.O1;
  const client = createPublicClient({ transport: http(chain.rpc) });
  const wallet = createWalletClient({ account: signer.account, transport: http(chain.rpc) });
  const usdc = getContract({ address: chain.usdc, abi: ERC20_ABI, client });

  const plan = [];
  for (const safe of selectSafes(flags)) {
    const want = parseUnits(fundAmount(safe, chain), 6);
    if (want === 0n) continue;                  // includes BENCH_GS013, empty ON PURPOSE
    const kit = await predictedKit(safe, chain, cast, undefined);
    const address = await kit.getAddress();
    const code = await client.getCode({ address }).catch(() => undefined);
    if (!code || code === '0x') { console.log(`  skip ${safe.id} — not deployed yet`); continue; }
    const have = await usdc.read.balanceOf([address]);
    if (have >= want) continue;                 // idempotent
    plan.push({ safe, address, amount: want - have });
  }

  if (!plan.length) { console.log(`\n  nothing to fund — every Safe already holds its manifest amount.\n`); return; }

  const total = plan.reduce((a, p) => a + p.amount, 0n);
  const held = await usdc.read.balanceOf([signer.address]);
  console.log(`\n  ${chain.name} (${chain.id}) — funding ${plan.length} Safe(s) from O1`);
  for (const p of plan) console.log(`    ${p.safe.id.padEnd(14)} ${formatUnits(p.amount, 6).padStart(10)} USDC -> ${p.address}`);
  console.log(`    ${'TOTAL'.padEnd(14)} ${formatUnits(total, 6).padStart(10)} USDC   (O1 holds ${formatUnits(held, 6)})`);
  if (held < total) die(`O1 holds ${formatUnits(held, 6)} USDC but ${formatUnits(total, 6)} is required.`);
  if (!flags.yes) { console.log(`\n  Dry run. Re-run with --yes to broadcast.\n`); return; }

  for (const { safe, address, amount } of plan) {
    const hash = await wallet.writeContract({
      address: chain.usdc, abi: ERC20_ABI, functionName: 'transfer',
      args: [address, amount], chain: null,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`  ${receipt.status === 'success' ? 'OK  ' : 'FAIL'} ${safe.id.padEnd(14)} ${chain.explorer}/tx/${hash}`);
  }
  console.log();
}

/**
 * recycle — close the loop.
 *
 * Value only ever flowed one way: O1 -> Safe -> PAYEE. The Sepolia faucet gives
 * 20 USDC and the manifest allocates 17 of it, so once the cast had been drained
 * once there was nothing left to drain and the volume run stopped at 25 executions
 * for want of a return path, not for want of gas. Drains are sponsored through
 * KeeperHub; the only real budget here is the faucet.
 *
 * This moves drained USDC from PAYEE back to O1 so `fund` -> `stage` -> drain can
 * run again. It touches no Safe: a Safe's balance is gavel's to move, and moving it
 * from here would be the seeder doing the product's job.
 *
 * This does NOT change what the volume means. It is still mechanism volume from
 * Safes we own, disclosed as such, and never summed with third-party volume. The
 * loop now recycles; say so wherever the seeding is disclosed.
 */
async function cmdRecycle(chain, cast, flags) {
  const from = cast.PAYEE;
  const to = cast.O1;
  const client = createPublicClient({ transport: http(chain.rpc) });
  const wallet = createWalletClient({ account: from.account, transport: http(chain.rpc) });
  const usdc = getContract({ address: chain.usdc, abi: ERC20_ABI, client });

  const held = await usdc.read.balanceOf([from.address]);
  const gas = await client.getBalance({ address: from.address });

  console.log(`\n  ${chain.name} (${chain.id}) — recycle PAYEE -> O1`);
  console.log(`    PAYEE  ${from.address}  ${formatUnits(held, 6)} USDC  ${formatUnits(gas, 18)} ETH`);
  console.log(`    O1     ${to.address}`);

  if (held === 0n) { console.log(`\n  nothing to recycle — PAYEE holds no USDC.\n`); return; }

  const amount = flags.amount ? parseUnits(String(flags.amount), 6) : held;
  if (amount > held) die(`asked to recycle ${formatUnits(amount, 6)} USDC but PAYEE holds ${formatUnits(held, 6)}.`);
  // PAYEE pays its own gas here — this transfer is not sponsored, unlike the drains.
  if (gas === 0n) die(`PAYEE holds no ETH and must pay gas for this transfer. Fund ${from.address} first.`);

  console.log(`    move   ${formatUnits(amount, 6)} USDC`);
  if (!flags.yes) { console.log(`\n  Dry run. Re-run with --yes to broadcast.\n`); return; }

  const hash = await wallet.writeContract({
    address: chain.usdc, abi: ERC20_ABI, functionName: 'transfer',
    args: [to.address, amount], chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${receipt.status === 'success' ? 'OK  ' : 'FAIL'} ${chain.explorer}/tx/${hash}`);
  const after = await usdc.read.balanceOf([to.address]);
  console.log(`  O1 now holds ${formatUnits(after, 6)} USDC — ready to fund another cycle.\n`);
}

/**
 * stage — manufacture the product condition.
 *
 * Builds a USDC payout, has exactly `threshold` owners sign it, proposes it to the
 * Safe Transaction Service, and then STOPS. The transaction is fully authorised and
 * deliberately not executed: that is the thing gavel exists to drain, and the thing
 * that has to age.
 *
 * Signing is off-chain and free — no gas, no on-chain transaction. Only the eventual
 * execTransaction costs anything, and executing is precisely what we do not do here.
 */
/**
 * HOSTILE — queue shapes that force one named refusal.
 *
 * WHY THESE EXIST. The nine named outcomes were covered by unit tests over
 * fixtures and by nothing else: no refusal had ever been OBSERVED against a real
 * Safe and a real chain, because the happy path is the only thing `stage` could
 * produce. A refusal branch proven only in test/ is a claim about a pure
 * function; a refusal branch with a row in docs/outcomes-<chain>.jsonl is a claim
 * about this software. Those are different evidence.
 *
 * WHY THEY GO ON ROSTERED SAFES. `not-on-roster` is the FIRST check in
 * assemble.mjs, so every BENCH_* Safe — all of which carry roster:false — refuses
 * on the roster gate before reaching the outcome the manifest built it for. The
 * bench cast cannot demonstrate its own scenarios. Rather than weaken I3 with a
 * bypass flag, the hostile queue is staged on a Safe that is genuinely on the
 * roster, and the refusal is genuinely the one under test.
 *
 * COST AND CONSEQUENCE. A proposal is an off-chain signature: these three cost no
 * gas and touch no chain state. But the hostile transaction occupies the Safe's
 * CURRENT nonce, so that Safe stops being drainable until the nonce moves — which
 * is the point, and is why HERO_A (the demo Safe) and VOL_1 (threshold 1, the
 * cheapest volume Safe) are left out of the campaign.
 */
const HOSTILE = {
  'below-threshold': {
    needs: (safe) => safe.threshold >= 2 || 'needs threshold >= 2; at threshold 1 the proposer alone meets it',
    describe: 'sign with the proposer ONLY, leaving the queue short of threshold',
    // Nothing to change about the payload — the shortfall IS the shape.
    signToThreshold: false,
  },
  'refund-requested': {
    needs: () => true,
    describe: 'non-zero gasPrice — the refund drain vector aimed at the executor (I4)',
    options: { gasPrice: '1' },
    signToThreshold: true,
  },
  'inner-call-failed': {
    needs: (safe) => safe.mustStayEmpty || safe.id === 'BENCH_GS013'
      || 'use BENCH_GS013 — the Safe the manifest keeps deliberately empty for exactly this',
    describe: 'a payout the Safe cannot cover: execTransaction succeeds, the inner transfer reverts (GS013)',
    // Costs no gas. drain.mjs gate 2 runs a local eth_call, sees execTransaction
    // return success=false, and refuses to broadcast -- so the outcome is observed
    // WITHOUT burning a nonce or paying for a transaction that moves nothing.
    overpay: true,
    signToThreshold: true,
  },
  'delegatecall-refused': {
    needs: () => true,
    describe: 'operation = 1, a DELEGATECALL into someone else\'s treasury (I5)',
    operation: 1,
    signToThreshold: true,
  },
};

async function cmdStage(chain, cast, flags) {
  const id = flags.safe;
  if (!id || id === true) die(`--safe <ID> is required, e.g. --safe HERO_A`);
  const safe = MANIFEST.safes.find((s) => s.id === id);
  if (!safe) die(`unknown safe "${id}"`);

  const variant = flags.hostile && flags.hostile !== true ? flags.hostile : null;
  if (flags.hostile === true) die(`--hostile needs a variant: ${Object.keys(HOSTILE).join(', ')}`);
  const hostile = variant ? HOSTILE[variant] : null;
  if (variant && !hostile) die(`unknown --hostile "${variant}". Known: ${Object.keys(HOSTILE).join(', ')}`);
  // A hostile stage on an off-roster Safe would be silently pointless: drain.mjs
  // refuses on the roster gate first and the outcome under test is never reached.
  if (hostile && !safe.roster) {
    die(`${id} is roster:false. not-on-roster is checked FIRST, so it would shadow ${variant}. ` +
        `Stage hostile queues on a rostered Safe.`);
  }
  if (hostile) {
    const ok = hostile.needs(safe);
    if (ok !== true) die(`${id} cannot carry "${variant}": ${ok}`);
  }

  const client = createPublicClient({ transport: http(chain.rpc) });
  const usdc = getContract({ address: chain.usdc, abi: ERC20_ABI, client });
  const apiKit = new SafeApiKit({ chainId: BigInt(chain.id), apiKey: loadSafeApiKey() });

  // Address resolution goes through the same predicted path as every other command,
  // so a staged transaction can never target a Safe the manifest did not describe.
  const address = await (await predictedKit(safe, chain, cast, undefined)).getAddress();
  const code = await client.getCode({ address }).catch(() => undefined);
  if (!code || code === '0x') die(`${id} is not deployed on ${chain.name}. Run: deploy --chain ${chain.id} --yes`);

  const held = await usdc.read.balanceOf([address]);
  const amount = flags.amount && flags.amount !== true
    ? parseUnits(String(flags.amount), 6)
    : held;                                   // default: pay out everything it holds
  // A hostile queue is refused before broadcast by construction, so it never needs
  // a balance to be a valid test of the refusal. Requiring one would make these
  // scenarios cost money for no reason.
  if (amount === 0n && !hostile) die(`${id} holds no USDC — nothing to stage. Run: fund --chain ${chain.id} --yes`);
  // overpay: ask for more than the Safe holds, so the ERC-20 transfer must revert.
  const payout = hostile?.overpay ? held + parseUnits('1', 6) : (amount === 0n ? 1n : amount);
  // The overpay variant is the whole point of inner-call-failed: the transfer must
  // exceed the balance so the inner call reverts. Every other path keeps the guard.
  if (amount > held && !hostile?.overpay) {
    die(`${id} holds ${formatUnits(held, 6)} USDC but ${formatUnits(amount, 6)} was requested.`);
  }

  const to = cast.PAYEE.address;
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, payout] });

  console.log(`\n  ${chain.name} (${chain.id}) — staging a ${hostile ? `HOSTILE queue (${variant})` : 'payout'} on ${id}`);
  console.log(`    Safe       ${address}`);
  console.log(`    payout     ${formatUnits(payout, 6)} USDC -> PAYEE ${to}`);
  console.log(`    threshold  ${safe.threshold} of ${safe.owners.length}`);
  if (hostile) {
    console.log(`    shape      ${hostile.describe}`);
    console.log(`    expect     drain.mjs refuses with "${variant}" and records a row`);
    console.log(`    NOTE       this occupies the CURRENT nonce — ${id} stops being drainable until it moves`);
  }
  if (!flags.yes) { console.log(`\n  Dry run. Re-run with --yes to propose and sign.\n`); return; }

  // The proposer must be an owner. Signing order is irrelevant to the service; the
  // ASCENDING-owner order checkSignatures requires is imposed later by assemble.mjs.
  const [proposer, ...rest] = safe.owners;
  const kit = await Safe.init({ provider: chain.rpc, signer: cast[proposer].pk, safeAddress: address });

  const safeTransaction = await kit.createTransaction({
    transactions: [{
      to: chain.usdc, value: '0', data,
      ...(hostile?.operation !== undefined ? { operation: hostile.operation } : {}),
    }],
    ...(hostile?.options ? { options: hostile.options } : {}),
  });
  const safeTxHash = await kit.getTransactionHash(safeTransaction);
  const proposerSig = await kit.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress: address,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: cast[proposer].address,
    senderSignature: proposerSig.data,
  });
  console.log(`\n  proposed  safeTxHash ${safeTxHash}`);
  console.log(`  signed    ${proposer} (proposer)`);

  // Confirm with just enough additional owners to reach threshold — no more. An
  // over-signed transaction would hide the below-threshold and drift branches we
  // need reachable elsewhere in the cast.
  // below-threshold is produced by NOT signing: the proposer's lone signature is
  // the whole shape, so the confirm loop is skipped rather than short-circuited
  // somewhere deeper where it would look like a bug.
  const wanted = hostile && hostile.signToThreshold === false ? 0 : safe.threshold - 1;
  for (const role of rest.slice(0, wanted)) {
    const ownerKit = await Safe.init({ provider: chain.rpc, signer: cast[role].pk, safeAddress: address });
    const sig = await ownerKit.signHash(safeTxHash);
    await apiKit.confirmTransaction(safeTxHash, sig.data);
    console.log(`  signed    ${role}`);
  }

  const pending = await apiKit.getPendingTransactions(address);
  const staged = pending.results.find((t) => t.safeTxHash === safeTxHash);
  console.log(`\n  queue depth ${pending.count} · confirmations ${staged?.confirmations?.length ?? 0}/${staged?.confirmationsRequired ?? safe.threshold}`);
  if (hostile) {
    console.log(`  HOSTILE QUEUE STAGED — expect drain.mjs to refuse with "${variant}".`);
    console.log(`  Verify: node scripts/drain.mjs --chain ${chain.id} --address ${address}\n`);
  } else {
    console.log(`  THRESHOLD MET AND DELIBERATELY UNEXECUTED — this is the condition gavel drains.\n`);
  }
}

/**
 * roster — regenerate src/roster.json from the manifest.
 *
 * The opt-in list is DERIVED, never hand-kept: a Safe is on the roster because the
 * manifest says so, and its address comes from the same CREATE2 prediction every
 * other command uses. Hand-editing this file is how a Safe ends up executable that
 * nobody decided to make executable.
 */
/**
 * govern — the two outcomes that need the Safe's OWN configuration to change.
 *
 * threshold-drift and owner-removed cannot be staged as a queue shape. They are
 * what happens when a payout is signed legitimately and the Safe then changes
 * underneath it, so producing them means actually executing a config change
 * on-chain. This is the only command in the seeder that spends gas on something
 * other than a payout.
 *
 * THE ORDERING IS THE WHOLE TRICK, and getting it wrong yields a different
 * outcome that looks superficially right:
 *
 *   1. Propose the payout at nonce N+1 and sign it to the CURRENT threshold. The
 *      Safe Transaction Service stamps confirmationsRequired at proposal time, so
 *      this transaction permanently remembers that 2 signatures were once enough.
 *   2. Propose the config change at nonce N, sign it, and EXECUTE it. The nonce
 *      advances to N+1 and the payout from step 1 becomes the live one.
 *   3. drain.mjs now reads a queue that believes it is ready and a chain that
 *      disagrees. That disagreement is the outcome.
 *
 * Do it in the other order and step 1's proposal is stamped with the NEW threshold,
 * which produces below-threshold instead of threshold-drift -- a strictly weaker
 * result that would still look like a refusal in the log.
 */
const GOVERN = {
  'raise-threshold': {
    describe: (safe) => `raise threshold ${safe.threshold} -> ${safe.threshold + 1} after signing`,
    produces: 'threshold-drift',
    build: (kit, safe, cast) => kit.createTransaction({
      transactions: [{
        to: null, value: '0',
        data: encodeFunctionData({ abi: SAFE_GOV_ABI, functionName: 'changeThreshold',
          args: [BigInt(safe.threshold + 1)] }),
      }],
    }),
  },
  'remove-owner': {
    describe: (safe) => `remove owner ${safe.owners[1]}, whose signature is already on the payout`,
    produces: 'owner-removed',
    build: (kit, safe, cast) => kit.createTransaction({
      transactions: [{
        to: null, value: '0',
        // prevOwner is the SENTINEL when removing the head of Safe's owner linked
        // list. owners[1] is the second owner, so its predecessor is owners[0].
        data: encodeFunctionData({ abi: SAFE_GOV_ABI, functionName: 'removeOwner',
          args: [cast[safe.owners[0]].address, cast[safe.owners[1]].address, BigInt(safe.threshold - 1)] }),
      }],
    }),
  },
};

const SAFE_GOV_ABI = [
  { type: 'function', name: 'changeThreshold', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'removeOwner', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [] },
];

async function cmdGovern(chain, cast, flags) {
  const id = flags.safe;
  if (!id || id === true) die(`--safe <ID> is required, e.g. --safe BENCH_GOV`);
  const safe = MANIFEST.safes.find((s) => s.id === id);
  if (!safe) die(`unknown safe "${id}"`);
  const action = flags.action && flags.action !== true ? flags.action : null;
  const plan = action ? GOVERN[action] : null;
  if (!plan) die(`--action needs one of: ${Object.keys(GOVERN).join(', ')}`);
  if (!safe.roster) die(`${id} is roster:false — not-on-roster would shadow ${plan.produces}.`);

  const client = createPublicClient({ transport: http(chain.rpc) });
  const usdc = getContract({ address: chain.usdc, abi: ERC20_ABI, client });
  const apiKit = new SafeApiKit({ chainId: BigInt(chain.id), apiKey: loadSafeApiKey() });
  const address = await (await predictedKit(safe, chain, cast, undefined)).getAddress();

  const held = await usdc.read.balanceOf([address]);
  const [proposer, second, ...others] = safe.owners;

  console.log(`\n  ${chain.name} (${chain.id}) — ${plan.produces} on ${id}`);
  console.log(`    Safe       ${address}`);
  console.log(`    change     ${plan.describe(safe)}`);
  console.log(`    produces   drain.mjs should refuse with "${plan.produces}"`);
  console.log(`    SPENDS GAS — one execTransaction from ${proposer}`);
  if (!flags.yes) { console.log(`\n  Dry run. Re-run with --yes.\n`); return; }

  const kit = await Safe.init({ provider: chain.rpc, signer: cast[proposer].pk, safeAddress: address });
  const startNonce = Number(await kit.getNonce());

  // ---- step 1: the payout that the config change will invalidate --------------
  const payout = held > 0n ? held : parseUnits('1', 6);
  const payoutTx = await kit.createTransaction({
    transactions: [{
      to: chain.usdc, value: '0',
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [cast.PAYEE.address, payout] }),
    }],
    options: { nonce: startNonce + 1 },
  });
  const payoutHash = await kit.getTransactionHash(payoutTx);
  await apiKit.proposeTransaction({
    safeAddress: address, safeTransactionData: payoutTx.data, safeTxHash: payoutHash,
    senderAddress: cast[proposer].address, senderSignature: (await kit.signHash(payoutHash)).data,
  });
  for (const role of [second, ...others].slice(0, safe.threshold - 1)) {
    const ok = await Safe.init({ provider: chain.rpc, signer: cast[role].pk, safeAddress: address });
    await apiKit.confirmTransaction(payoutHash, (await ok.signHash(payoutHash)).data);
  }
  console.log(`\n  [1/2] payout   proposed at nonce ${startNonce + 1}, signed to ${safe.threshold} — ${payoutHash.slice(0, 18)}…`);

  // ---- step 2: the config change, executed --------------------------------
  const govTx = await plan.build(kit, safe, cast);
  govTx.data.to = address;                       // a Safe config change targets the Safe itself
  const govHash = await kit.getTransactionHash(govTx);
  govTx.addSignature(await kit.signHash(govHash));
  for (const role of [second, ...others].slice(0, safe.threshold - 1)) {
    const ok = await Safe.init({ provider: chain.rpc, signer: cast[role].pk, safeAddress: address });
    govTx.addSignature(await ok.signHash(govHash));
  }
  const res = await kit.executeTransaction(govTx);
  const receipt = await client.waitForTransactionReceipt({ hash: res.hash });
  console.log(`  [2/2] config   EXECUTED ${plan.describe(safe)}`);
  console.log(`                 tx ${chain.explorer}/tx/${res.hash} · ${receipt.status}`);
  console.log(`\n  nonce ${startNonce} -> ${await kit.getNonce()}. The payout is now live and stale.`);
  console.log(`  Verify: node scripts/drain.mjs --chain ${chain.id} --address ${address}\n`);
}

async function cmdRoster(chain, cast, flags) {
  const existing = JSON.parse(readFileSync(join(ROOT, 'src', 'roster.json'), 'utf8'));
  const wanted = MANIFEST.safes.filter((s) => s.roster);
  const safes = [];
  for (const safe of wanted) {
    safes.push(await (await predictedKit(safe, chain, cast, undefined)).getAddress());
  }
  const next = {
    ...existing,
    byChain: { ...(existing.byChain ?? {}), [chain.id]: safes },
  };
  delete next.chainId; delete next.safes;      // supersede the flat single-chain shape
  const path = join(ROOT, 'src', 'roster.json');
  if (!flags.yes) {
    console.log(`\n  ${chain.name} (${chain.id}) — ${safes.length} roster Safe(s):`);
    wanted.forEach((s, i) => console.log(`    ${s.id.padEnd(14)} ${safes[i]}`));
    console.log(`\n  Dry run. Re-run with --yes to write ${path.replace(ROOT, 'build')}.\n`);
    return;
  }
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  console.log(`\n  wrote ${safes.length} roster Safe(s) for chain ${chain.id} to build/src/roster.json`);
  console.log(`  re-run scripts/sync.mjs to embed them in the workflow\n`);
}

/* ------------------------------------------------------------------ main */

const { cmd, flags } = parseArgs(process.argv);
const chain = resolveChain(flags);
const cast = loadCast();

const COMMANDS = { status: cmdStatus, predict: cmdPredict, deploy: cmdDeploy, fund: cmdFund, stage: cmdStage, recycle: cmdRecycle, roster: cmdRoster, govern: cmdGovern };
if (!COMMANDS[cmd]) {
  die(`unknown command "${cmd ?? ''}". Expected one of: ${Object.keys(COMMANDS).join(', ')}`);
}
await COMMANDS[cmd](chain, cast, flags);
