/**
 * The outcome ledger's own invariants.
 *
 * The one that earns its place is the last: it reads every `refuse(...)` call
 * site out of src/assemble.mjs and asserts the taxonomy knows all of them. That
 * test is not decorative — it is the test that would have caught
 * `malformed-payload`, a twelfth reachable reason that build/README.md does not
 * list among its "nine named outcomes" and two guards, and which would otherwise
 * have thrown inside drain.mjs at the exact moment a refusal needed recording.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TAXONOMY, OPERATIONAL, shapeOutcome } from '../scripts/outcome-log.mjs';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('shapeOutcome refuses an outcome nobody declared', () => {
  assert.throws(
    () => shapeOutcome({ at: 'T', chainId: '1', safe: '0xa', outcome: 'vibes', stage: 'assemble' }),
    /neither one of the twelve named reasons nor a known operational state/,
  );
});

test('a taxonomy row carries its index and who decided it', () => {
  const row = shapeOutcome({
    at: 'T', chainId: 8453, safe: '0xa', outcome: 'raced-gs026', stage: 'eth_call',
  });
  assert.equal(row.class, 'refusal');
  assert.equal(row.taxonomyIndex, 8);
  assert.equal(row.decidedBy, 'chain', 'GS026 is read off the chain, never decided by the pure function');
  assert.equal(row.chainId, '8453', 'chainId is stringified so 8453 and "8453" cannot split the log');
});

test('an operational row is never given a taxonomy index', () => {
  const row = shapeOutcome({
    at: 'T', chainId: '1', safe: '0xa', outcome: 'executed', stage: 'broadcast',
    executionId: 'abc', tx: '0xdead',
  });
  assert.equal(row.class, 'execution');
  assert.equal(row.taxonomyIndex, null, 'plumbing must never pad the coverage table');
  assert.equal(row.decidedBy, 'runner');
});

test('nonce and threshold are stringified, because BigInt does not survive JSON', () => {
  const row = shapeOutcome({
    at: 'T', chainId: '1', safe: '0xa', outcome: 'below-threshold', stage: 'assemble',
    nonce: 7n, threshold: 3n,
  });
  assert.equal(row.nonce, '7');
  assert.equal(row.threshold, '3');
});

test('the taxonomy knows every reason assemble.mjs can actually return', () => {
  const text = src('../src/assemble.mjs');
  // Both shapes: refuse('name', ...) on one line, and the two-line form where the
  // reason sits on the line after `return refuse(`.
  const found = new Set([...text.matchAll(/refuse\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
  // The one reason chosen dynamically rather than written as a literal argument.
  for (const m of text.matchAll(/\?\s*'(threshold-drift)'\s*:\s*'(below-threshold)'/g)) {
    found.add(m[1]); found.add(m[2]);
  }
  assert.ok(found.size >= 10, `expected to find the refusal reasons in assemble.mjs, found ${found.size}`);
  for (const reason of found) {
    assert.ok(
      Object.hasOwn(TAXONOMY, reason),
      `src/assemble.mjs can return "${reason}" and scripts/outcome-log.mjs does not know it — ` +
      `drain.mjs would throw while trying to record that refusal`,
    );
  }
});

test('the two post-broadcast outcomes are the only ones the chain decides', () => {
  const byChain = Object.entries(TAXONOMY).filter(([, v]) => v.decidedBy === 'chain').map(([k]) => k);
  assert.deepEqual(byChain.sort(), ['inner-call-failed', 'raced-gs026']);
});

test('no name is both a taxonomy reason and an operational state', () => {
  for (const k of Object.keys(OPERATIONAL)) {
    assert.ok(!Object.hasOwn(TAXONOMY, k), `"${k}" is declared twice and would be classed at random`);
  }
});
