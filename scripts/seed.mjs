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
 *
 * Usage
 *   node scripts/seed.mjs status  --chain 11155111
 *   node scripts/seed.mjs predict --chain 11155111
 *   node scripts/seed.mjs deploy  --chain 11155111 [--only HERO_A,VOL_1] [--yes]
 *   node scripts/seed.mjs fund    --chain 11155111 [--yes]
 *
 * Keys never enter this tree. They are parsed out of ~/.config/gavel/seed.txt,
 * which is `cast wallet new-mnemonic` output — a human-readable block, NOT
 * KEY=value, so it must be parsed and must never be `source`d.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import protocolKit from '@safe-global/protocol-kit';

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
    cast[role] = { address: account.address, account };
  });
  return cast;
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

/* ------------------------------------------------------------------ main */

const { cmd, flags } = parseArgs(process.argv);
const chain = resolveChain(flags);
const cast = loadCast();

const COMMANDS = { status: cmdStatus, predict: cmdPredict, deploy: cmdDeploy, fund: cmdFund };
if (!COMMANDS[cmd]) {
  die(`unknown command "${cmd ?? ''}". Expected one of: ${Object.keys(COMMANDS).join(', ')}`);
}
await COMMANDS[cmd](chain, cast, flags);
