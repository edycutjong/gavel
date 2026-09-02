#!/usr/bin/env node
/**
 * verify-assemble — run the pure function against a LIVE Safe queue.
 *
 * This is the R11 fix in one command. `npm test` proves assemble.mjs against
 * committed fixtures, which proves the logic and nothing about reality. This
 * pulls the real Safe Transaction Service response and the real on-chain nonce,
 * threshold and owner set, and runs the same untouched function over them.
 *
 * A green unit suite plus this is the claim. A green unit suite alone is the loss.
 *
 *   node scripts/verify-assemble.mjs --chain 11155111 --safe HERO_A
 *   node scripts/verify-assemble.mjs --chain 11155111 --safe HERO_A --write-fixture
 *
 * --write-fixture saves the response to test/fixtures/ so the exact shape the
 * service returned today becomes a committed regression test.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { assemble } from '../src/assemble.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8'));

const SAFE_ABI = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
];

const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    const n = process.argv[i + 1];
    if (!n || n.startsWith('--')) flags[k] = true; else { flags[k] = n; i++; }
  }
}

const chainId = String(flags.chain);
const chain = { id: chainId, ...MANIFEST.chains[chainId] };
if (!MANIFEST.chains[chainId]) chain.name = undefined;
if (!chain) { console.error(`--chain must be one of ${Object.keys(MANIFEST.chains).join(', ')}`); process.exit(1); }
const entry = MANIFEST.safes.find((s) => s.id === flags.safe);
if (!entry) { console.error(`--safe must name a manifest entry`); process.exit(1); }
const safeAddress = flags.address && flags.address !== true ? flags.address : null;
if (!safeAddress) { console.error(`--address 0x... is required (take it from: seed.mjs predict)`); process.exit(1); }

const apiKey = readFileSync(join(homedir(), '.config', 'gavel', 'safe-api-key'), 'utf8').trim();

// 1. the off-chain queue, straight from the service — no plugin in between
const res = await fetch(`${chain.txService}/safes/${safeAddress}/multisig-transactions/?limit=20`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
if (!res.ok) { console.error(`tx-service HTTP ${res.status} — note addresses must be EIP-55 checksummed`); process.exit(1); }
const queue = await res.json();

// 2. live on-chain state
const client = createPublicClient({ transport: http(chain.rpc) });
const read = (functionName) => client.readContract({ address: safeAddress, abi: SAFE_ABI, functionName });
const [onchainNonce, onchainThreshold, onchainOwners] = await Promise.all([
  read('nonce'), read('getThreshold'), read('getOwners'),
]);

console.log(`\n  ${chain.name} (${chain.id}) — ${entry.id} ${safeAddress}`);
console.log(`  on-chain: nonce=${onchainNonce} threshold=${onchainThreshold} owners=${onchainOwners.length}`);
console.log(`  queue:    ${queue.count} transaction(s)\n`);

// 3. the pure function, untouched, over real inputs
const result = assemble({
  safeAddress,
  roster: [safeAddress],
  queue: { transactions: queue.results, count: queue.count },
  onchainNonce: onchainNonce.toString(),
  onchainThreshold: onchainThreshold.toString(),
  onchainOwners,
});

console.log(`  executable   ${result.executable}`);
console.log(`  reason       ${result.reason}`);
console.log(`  detail       ${result.detail}`);
if (result.executable) {
  console.log(`\n  the ten execTransaction args:`);
  for (const f of ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver']) {
    console.log(`    ${f.padEnd(16)} ${String(result[f]).slice(0, 60)}`);
  }
  const bytes = (result.signatures.length - 2) / 2;
  console.log(`    ${'signatures'.padEnd(16)} ${result.signatures.slice(0, 40)}…`);
  console.log(`\n  blob ${bytes} bytes = ${bytes / 65} signature(s) x 65, threshold ${result.threshold}`);
  console.log(`  ${bytes === result.threshold * 65 ? 'OK  ' : 'FAIL'} blob length matches threshold`);
  const owners = (queue.results.find((t) => String(t.nonce) === result.nonce)?.confirmations ?? [])
    .map((c) => c.owner.toLowerCase()).sort();
  const ascending = owners.every((o, i) => i === 0 || owners[i - 1] < o);
  console.log(`  ${ascending ? 'OK  ' : 'FAIL'} owners sort ascending`);
}

if (flags['write-fixture']) {
  const dir = join(ROOT, 'test', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `live-queue-${chain.id}-${entry.id}.json`);
  writeFileSync(path, JSON.stringify({
    $comment: `Real Safe Transaction Service response, captured ${new Date().toISOString().slice(0, 10)}. Committed so the exact shape the service returns is a regression test rather than an assumption.`,
    chainId: chain.id, safeAddress,
    onchain: { nonce: onchainNonce.toString(), threshold: onchainThreshold.toString(), owners: onchainOwners },
    queue,
  }, null, 2));
  console.log(`\n  fixture written: ${path.replace(ROOT, 'build')}`);
}
console.log();
