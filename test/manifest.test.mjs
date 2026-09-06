/**
 * Invariants over the manifest and roster.
 *
 * These are cheap and they guard the things that would be embarrassing rather
 * than merely broken: counting testnet rows as evidence, executing against a
 * Safe nobody opted in, or shipping a chain constant nobody verified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const MANIFEST = read('../src/manifest.json');
const ROSTER = read('../src/roster.json');

test('exactly one chain is evidence-eligible, and it is Base mainnet', () => {
  const eligible = Object.entries(MANIFEST.chains).filter(([, c]) => c.receiptsEligible);
  assert.equal(eligible.length, 1, 'more than one eligible chain would let testnet rows be counted');
  assert.equal(eligible[0][0], '8453');
  assert.equal(eligible[0][1].role, 'judged');
});

test('every testnet chain is explicitly marked NOT evidence-eligible', () => {
  for (const [id, c] of Object.entries(MANIFEST.chains)) {
    if (id === '8453') continue;
    assert.equal(c.receiptsEligible, false, `chain ${id} must be receiptsEligible:false`);
  }
});

test('every chain carries a verified USDC address and a tx-service base', () => {
  for (const [id, c] of Object.entries(MANIFEST.chains)) {
    assert.match(c.usdc, /^0x[0-9a-fA-F]{40}$/, `${id} usdc`);
    assert.match(c.txService, /^https:\/\/api\.safe\.global\/tx-service\/[a-z]+\/api\/v2$/, `${id} txService`);
    // Every constant in this file was read from the chain, not from memory. The
    // note is the audit trail for that, so its absence is a real failure.
    assert.ok(c.usdcVerified?.includes('decimals=6'), `${id} usdc must be verified as 6dp`);
  }
});

test('the cast is 12 Safes with unique ids and unique salts', () => {
  assert.equal(MANIFEST.safes.length, 12);
  assert.equal(new Set(MANIFEST.safes.map((s) => s.id)).size, 12);
  assert.equal(new Set(MANIFEST.safes.map((s) => s.saltNonce)).size, 12,
    'a duplicate salt would collide two Safes onto one address');
});

test('every Safe threshold is reachable by its own owner set', () => {
  for (const s of MANIFEST.safes) {
    assert.ok(s.threshold >= 1, `${s.id} threshold must be >= 1`);
    assert.ok(s.threshold <= s.owners.length,
      `${s.id} needs ${s.threshold} of ${s.owners.length} owners — unsatisfiable`);
  }
});

test('the Safes that must stay empty are funded with zero on every chain', () => {
  // BENCH_GS013 produces inner-call-failed BECAUSE it is empty. Funding it by
  // accident silently deletes one of the nine named outcomes.
  for (const s of MANIFEST.safes.filter((x) => x.mustStayEmpty)) {
    for (const c of Object.values(MANIFEST.chains)) {
      assert.equal(s[c.fundKey], '0.000000', `${s.id} must stay empty (${c.name})`);
    }
  }
});

test('the rehearsal manifest fits the funding the testnet faucet actually gives', () => {
  const total = MANIFEST.safes.reduce((a, s) => a + Number(s.fundUsdcRehearsal ?? 0), 0);
  assert.ok(total <= 20, `rehearsal total ${total} USDC exceeds the 20 the faucet provides`);
});

test('the roster is a subset of the manifest Safes marked roster:true', () => {
  const expected = MANIFEST.safes.filter((s) => s.roster).length;
  for (const [chainId, addrs] of Object.entries(ROSTER.byChain ?? {})) {
    assert.equal(addrs.length, expected,
      `chain ${chainId} roster has ${addrs.length}, manifest marks ${expected}`);
    assert.equal(new Set(addrs.map((a) => a.toLowerCase())).size, addrs.length, 'duplicate roster entry');
    for (const a of addrs) assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  }
});

test('the executor is never an owner of any Safe in the cast', () => {
  // The product claim is "executed by an address that owns none of them". If the
  // executor ever appeared in an owner list the claim would be false, and the
  // demo would still pass — which is exactly why this is asserted here.
  const EXECUTOR = '0x5e2e5fd3ad7fdc9b94482930db8b5f45e439bab7';
  for (const s of MANIFEST.safes) {
    assert.ok(!s.owners.map((o) => o.toLowerCase()).includes(EXECUTOR),
      `${s.id} lists the executor as an owner`);
  }
});
