#!/usr/bin/env node
/**
 * gavel — scripts/drain.mjs
 *
 * Drains one Safe's queue THROUGH KeeperHub, without a workflow.
 *
 * WHY THIS EXISTS. The canonical mechanism is the `gavel-drain` workflow
 * (scripts/sync.mjs). It cannot be created on a free plan: `code/run-code` and
 * `HTTP Request` both require pro, and nothing discloses that before create time
 * (DX-7). This path reaches the same on-chain outcome through the **Direct
 * Execution API**, which is not plan-gated.
 *
 * WHAT IS AND IS NOT THE SAME:
 *   same  — the decision. src/assemble.mjs is imported here, not reimplemented.
 *           One copy of the logic, the copy the tests run.
 *   same  — the execution. KeeperHub's wallet signs and broadcasts
 *           execTransaction. Value moves through KeeperHub either way.
 *   DIFFERENT — the orchestration. The workflow decides inside KeeperHub; this
 *           decides here and asks KeeperHub to execute. That is a weaker answer
 *           to "execution *through* KeeperHub" and the README must say so rather
 *           than blur it.
 *
 * Three gates before anything broadcasts, and it stops at the first failure:
 *   1. assemble.mjs must return executable: true
 *   2. a local eth_call simulation must pass (wild-stalls.md W1 — a Safe guard
 *      can reject a fully-signed transaction with InvalidSignatures())
 *   3. KeeperHub's own `simulate: true` preflight must pass
 *
 *   node scripts/drain.mjs --chain 11155111 --address 0x... [--execute]
 *
 * Without --execute it stops after the gates. Dry by default, always.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { assemble } from '../src/assemble.mjs';
import { record } from './outcome-log.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8'));
const ROSTER = JSON.parse(readFileSync(join(ROOT, 'src', 'roster.json'), 'utf8'));

const EXEC_ABI = [{
  inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'signatures', type: 'bytes' },
  ],
  name: 'execTransaction', outputs: [{ name: 'success', type: 'bool' }],
  stateMutability: 'payable', type: 'function',
}];
const SAFE_ABI = [
  { inputs: [], name: 'nonce', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'getThreshold', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'getOwners', outputs: [{ type: 'address[]' }], stateMutability: 'view', type: 'function' },
];

const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2); const n = process.argv[i + 1];
    if (!n || n.startsWith('--')) flags[k] = true; else { flags[k] = n; i++; }
  }
}
const chainId = String(flags.chain ?? '');
const chain = MANIFEST.chains[chainId];
if (!chain) { console.error(`--chain must be one of ${Object.keys(MANIFEST.chains).join(', ')}`); process.exit(1); }
const safeAddress = flags.address && flags.address !== true ? flags.address : null;
if (!safeAddress) { console.error('--address 0x... required (EIP-55 checksummed)'); process.exit(1); }

const khKey = readFileSync(join(homedir(), '.config', 'keeperhub', 'env'), 'utf8')
  .match(/^KH_API_KEY=(.+)$/m)?.[1].trim().replace(/['"]/g, '');
if (!khKey) { console.error('KH_API_KEY missing from ~/.config/keeperhub/env'); process.exit(1); }
const safeKey = readFileSync(join(homedir(), '.config', 'gavel', 'safe-api-key'), 'utf8').trim();

// Every terminal state below goes through this, so a refusal is exactly as
// durable as an execution. See scripts/outcome-log.mjs for why that matters.
let logged = null;
const note = (outcome, stage, extra = {}) => {
  logged = record({
    at: new Date().toISOString(), chainId, safe: safeAddress, outcome, stage,
    receiptsEligible: chain.receiptsEligible, ...extra,
  });
  return logged;
};

const client = createPublicClient({ transport: http(chain.rpc) });
const read = (fn) => client.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: fn });

console.log(`\n  ${chain.name} (${chainId}) — draining ${safeAddress}`);
if (!chain.receiptsEligible) console.log(`  NOTE  receiptsEligible=false — nothing here may enter EVIDENCE.md.`);

// A Safe absent from this chain reads as "not a contract", and viem surfaces
// that as a raw ContractFunctionZeroDataError with a stack trace naming
// `nonce()` -- which reads as a broken ABI rather than an undeployed Safe. It
// is a precondition failure and belongs on the exit-1 channel with the other
// preconditions above, so a sweep over the roster names the Safe and stops
// instead of burying the reason in a trace. Checked before the tx-service call
// because there is no point asking for the queue of a Safe that is not there.
const code = await client.getCode({ address: safeAddress });
if (!code || code === '0x') {
  console.error(`  NOT DEPLOYED  no code at ${safeAddress} on ${chain.name} (${chainId})`);
  console.error(`                deploy the cast first: node scripts/seed.mjs deploy --chain ${chainId}`);
  note('safe-not-deployed', 'precondition', { detail: `no code at ${safeAddress}` });
  process.exit(1);
}

// ---- read: off-chain queue + on-chain state -------------------------------
const res = await fetch(`${chain.txService}/safes/${safeAddress}/multisig-transactions/?executed=false&ordering=nonce&limit=20`,
  { headers: { Authorization: `Bearer ${safeKey}` } });
if (!res.ok) {
  console.error(`  tx-service HTTP ${res.status} (addresses must be EIP-55 checksummed)`);
  note('tx-service-error', 'precondition', { detail: `HTTP ${res.status}` });
  process.exit(1);
}
const queue = await res.json();
const [nonce, threshold, owners] = await Promise.all([read('nonce'), read('getThreshold'), read('getOwners')]);

// ---- gate 1: the pure function --------------------------------------------
const r = assemble({
  safeAddress, roster: ROSTER.byChain?.[chainId] ?? [],
  queue: { transactions: queue.results, count: queue.count },
  onchainNonce: nonce.toString(), onchainThreshold: threshold.toString(), onchainOwners: owners,
});
console.log(`  queue ${queue.count} · nonce ${nonce} · threshold ${threshold}`);
console.log(`\n  [1/3] assemble  ${r.executable ? 'EXECUTABLE' : `REFUSED — ${r.reason}`}`);
console.log(`        ${r.detail}`);
// A named refusal is correct behaviour, not an error -- but a wrapper must be
// able to tell "refused" from "executed". Exit 3 is the refusal channel.
if (!r.executable) {
  note(r.reason, 'assemble', {
    detail: r.detail, queueCount: queue.count, nonce, threshold,
  });
  process.exit(3);
}

// ---- gate 2: local simulation ---------------------------------------------
const executor = flags.executor && flags.executor !== true
  ? flags.executor : '0x5E2e5Fd3aD7fDC9B94482930db8b5F45E439bab7';
const args = [
  r.to, BigInt(r.value), r.data, r.operation,
  BigInt(r.safeTxGas), BigInt(r.baseGas), BigInt(r.gasPrice),
  r.gasToken, r.refundReceiver, r.signatures,
];
try {
  const sim = await client.simulateContract({
    address: safeAddress, abi: EXEC_ABI, functionName: 'execTransaction', account: executor, args,
  });
  if (sim.result !== true) {
    // execTransaction returns success=false when the INNER call reverts. The outer
    // call still succeeds whenever safeTxGas != 0 (Safe: require(success ||
    // safeTxGas != 0 || gasPrice != 0)), so this does not throw -- it just moves
    // nothing while permanently consuming the Safe nonce and burning real gas.
    // Printing it and broadcasting anyway was the bug.
    console.log(`  [2/3] eth_call  INNER CALL REVERTS -- would consume the nonce and move nothing`);
    console.log(`        refusing to broadcast. This is the inner-call-failed / GS013 shape;`);
    console.log(`        to produce it deliberately, use BENCH_GS013 rather than a live payout.`);
    note('inner-call-failed', 'eth_call', {
      detail: 'execTransaction would return success=false: inner call reverts, nonce consumed, nothing moved',
      queueCount: queue.count, nonce, threshold,
    });
    process.exit(1);
  }
  console.log(`  [2/3] eth_call  SUCCEEDS`);
} catch (e) {
  // The reason is what makes this row diagnostic rather than decorative, and viem
  // puts it on a LATER line than shortMessage -- so splitting on the first newline
  // threw away the GS-code and left every revert looking identical. Keep the whole
  // message for classification; trim only what is printed.
  const full = String(e.shortMessage || e.message || e);
  const gs = full.match(/GS\d{3}/)?.[0] ?? null;
  const reason = full.match(/reverted with the following reason:\s*\n?\s*(.+)/)?.[1]?.trim();
  const msg = [full.split('\n')[0], gs ?? reason].filter(Boolean).join(' — ');
  console.log(`  [2/3] eth_call  REVERTS — ${msg.slice(0, 120)}`);
  console.log(`        refusing to broadcast a transaction that cannot land.`);
  // GS026 is Safe's "invalid owner provided" / already-consumed-nonce revert. When
  // it surfaces here it is the race, not a malformed blob, and it is outcome 8 --
  // not a generic precondition failure.
  // GS026 is an already-consumed nonce: the race, outcome 8. GS013 is the inner
  // call reverting while the outer one does not survive it, which is outcome 9 --
  // the same shape the sim.result === false branch above catches when safeTxGas is
  // non-zero. Both are named outcomes, not generic precondition noise.
  const outcome = gs === 'GS026' ? 'raced-gs026'
                : gs === 'GS013' ? 'inner-call-failed'
                : 'eth-call-reverted';
  note(outcome, 'eth_call', {
    detail: msg.slice(0, 200), queueCount: queue.count, nonce, threshold,
  });
  process.exit(1);
}

// ---- gate 3: KeeperHub's own preflight, then execute ----------------------
const body = {
  contractAddress: safeAddress,
  chainId: Number(chainId),
  functionName: 'execTransaction',
  abi: JSON.stringify(EXEC_ABI),
  functionArgs: JSON.stringify([
    r.to, r.value, r.data, r.operation, r.safeTxGas, r.baseGas, r.gasPrice,
    r.gasToken, r.refundReceiver, r.signatures,
  ]),
  gasLimitMultiplier: '1.3',
};

const call = (payload) => fetch('https://app.keeperhub.com/api/execute/contract-call', {
  method: 'POST',
  headers: { Authorization: `Bearer ${khKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}).then(async (x) => ({ ok: x.ok, status: x.status, json: await x.json().catch(() => ({})) }));

const pre = await call({ ...body, simulate: true });
// pre.ok is Response.ok -- transport success. A 2xx body carrying
// {success:false, revertReason:"GS026"} would have sailed through the "third
// gate", which made it a liveness check on the API rather than a preflight on
// the transaction. Inspect the body.
const preBad = pre.json?.success === false || pre.json?.error || pre.json?.revertReason;
console.log(`  [3/3] KeeperHub simulate  HTTP ${pre.status} ${pre.ok && !preBad ? 'OK' : 'FAILED'}`);
if (!pre.ok || preBad) {
  const body300 = JSON.stringify(pre.json).slice(0, 300);
  console.log(`        ${body300}`);
  note(/GS026/.test(body300) ? 'raced-gs026' : 'preflight-failed', 'keeperhub-simulate', {
    detail: body300, queueCount: queue.count, nonce, threshold,
  });
  process.exit(1);
}

if (!flags.execute) {
  console.log(`\n  All three gates passed. Dry run — re-run with --execute to broadcast.\n`);
  note('executable-dry', 'gates', { queueCount: queue.count, nonce, threshold });
  process.exit(0);
}

const out = await call(body);
const j = out.json;
console.log(`\n  EXECUTED through KeeperHub`);
console.log(`    executionId  ${j.executionId ?? '(none)'}`);
console.log(`    status       ${j.status ?? out.status}`);
if (j.transactionHash) console.log(`    tx           ${chain.explorer}/tx/${j.transactionHash}`);
else console.log(`    no transactionHash — the call never broadcast: ${JSON.stringify(j).slice(0, 240)}`);
// A losing race comes back HERE, in the execute response body, not from either
// preflight: both gates passed because at the moment they ran the nonce was still
// live. Classifying this as generic no-hash plumbing would file the single most
// interesting thing that can happen to an executor under "misc".
const outBody = JSON.stringify(j);
const outGs = outBody.match(/GS\d{3}/)?.[0] ?? null;
note(
  j.transactionHash ? 'executed'
  : outGs === 'GS026' ? 'raced-gs026'
  : outGs === 'GS013' ? 'inner-call-failed'
  : 'broadcast-no-hash',
  'broadcast',
  {
    detail: j.transactionHash ? null : outBody.slice(0, 240),
    executionId: j.executionId ?? null, tx: j.transactionHash ?? null,
    queueCount: queue.count, nonce, threshold,
  },
);
console.log();
