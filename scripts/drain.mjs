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

const client = createPublicClient({ transport: http(chain.rpc) });
const read = (fn) => client.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: fn });

console.log(`\n  ${chain.name} (${chainId}) — draining ${safeAddress}`);
if (!chain.receiptsEligible) console.log(`  NOTE  receiptsEligible=false — nothing here may enter EVIDENCE.md.`);

// ---- read: off-chain queue + on-chain state -------------------------------
const res = await fetch(`${chain.txService}/safes/${safeAddress}/multisig-transactions/?executed=false&ordering=nonce&limit=20`,
  { headers: { Authorization: `Bearer ${safeKey}` } });
if (!res.ok) { console.error(`  tx-service HTTP ${res.status} (addresses must be EIP-55 checksummed)`); process.exit(1); }
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
if (!r.executable) process.exit(3);

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
    process.exit(1);
  }
  console.log(`  [2/3] eth_call  SUCCEEDS`);
} catch (e) {
  const msg = String(e.shortMessage || e.message || e).split('\n')[0];
  console.log(`  [2/3] eth_call  REVERTS — ${msg.slice(0, 120)}`);
  console.log(`        refusing to broadcast a transaction that cannot land.`);
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
  console.log(`        ${JSON.stringify(pre.json).slice(0, 300)}`);
  process.exit(1);
}

if (!flags.execute) {
  console.log(`\n  All three gates passed. Dry run — re-run with --execute to broadcast.\n`);
  process.exit(0);
}

const out = await call(body);
const j = out.json;
console.log(`\n  EXECUTED through KeeperHub`);
console.log(`    executionId  ${j.executionId ?? '(none)'}`);
console.log(`    status       ${j.status ?? out.status}`);
if (j.transactionHash) console.log(`    tx           ${chain.explorer}/tx/${j.transactionHash}`);
else console.log(`    no transactionHash — the call never broadcast: ${JSON.stringify(j).slice(0, 240)}`);
console.log();
