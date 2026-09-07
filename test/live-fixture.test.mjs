/**
 * Regression tests over a REAL Safe Transaction Service response.
 *
 * test/assemble.test.mjs proves the logic against fixtures we wrote, which proves
 * we are self-consistent and nothing about the service. This file runs the same
 * untouched function over bytes the service actually returned, captured by
 * `node scripts/verify-assemble.mjs --write-fixture`.
 *
 * If Safe changes the response shape, these fail — which is the entire point.
 * Every assertion below was UNKNOWN when assemble.mjs was written; each one is a
 * risk that has been retired, not a behaviour that was assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/assemble.mjs';

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/live-queue-11155111-HERO_A.json', import.meta.url)), 'utf8'));

const input = () => ({
  safeAddress: FIXTURE.safeAddress,
  roster: [FIXTURE.safeAddress],
  queue: { transactions: FIXTURE.queue.results, count: FIXTURE.queue.count },
  onchainNonce: FIXTURE.onchain.nonce,
  onchainThreshold: FIXTURE.onchain.threshold,
  onchainOwners: FIXTURE.onchain.owners,
});

const candidate = () => FIXTURE.queue.results.find(
  (t) => String(t.nonce) === String(FIXTURE.onchain.nonce));

/* ------------------------------------------- what the service actually returns */

test('the service returns raw 65-byte signatures in confirmations[]', () => {
  // THE risk this project was named against: the documented output of
  // safe/get-pending-transactions never mentions a `signature` field, and without
  // one there is no blob to assemble and no product.
  for (const c of candidate().confirmations) {
    assert.match(c.signature, /^0x[0-9a-fA-F]{130}$/, `${c.owner} must carry 65 bytes`);
  }
});

test('signatures carry eth_sign v values, so pass-through is correct', () => {
  // assemble.mjs refuses to normalise v, on the grounds that Safe's own
  // clients already write what checkSignatures expects. This asserts that ground.
  // 27/28 = EIP-712, 31/32 = eth_sign. Anything else would mean normalisation is
  // needed after all, and the six-line crypto surface grows.
  for (const c of candidate().confirmations) {
    const v = parseInt(c.signature.slice(-2), 16);
    assert.ok([27, 28, 31, 32].includes(v), `v=${v} from ${c.owner} is outside the pass-through set`);
  }
});

test('the raw service response carries all five fields the plugin omits', () => {
  // The KeeperHub plugin projection drops these (DX-1), which is why the
  // HTTP Request node is baseline architecture rather than a fallback. If the
  // service ever dropped them too, `incomplete-payload` would fire forever.
  const t = candidate();
  for (const f of ['safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver']) {
    assert.notEqual(t[f], undefined, `${f} must be present in the raw response`);
  }
});

/* ------------------------------------------------ the function over real bytes */

test('assemble executes a real threshold-met transaction', () => {
  const r = assemble(input());
  assert.equal(r.executable, true, r.detail);
  assert.equal(r.reason, 'ok');
});

test('the blob is exactly threshold x 65 bytes', () => {
  const r = assemble(input());
  assert.equal((r.signatures.length - 2) / 2, r.threshold * 65);
});

test('the blob concatenates the real signatures in ascending owner order', () => {
  const r = assemble(input());
  const expected = '0x' + candidate().confirmations
    .slice()
    .sort((a, b) => (a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1))
    .slice(0, r.threshold)
    .map((c) => c.signature.replace(/^0x/, ''))
    .join('');
  assert.equal(r.signatures, expected);
});

test('all ten execTransaction arguments are populated from real data', () => {
  const r = assemble(input());
  const t = candidate();
  assert.equal(r.to, t.to);
  assert.equal(r.operation, 0);
  assert.equal(r.gasPrice, '0');
  for (const f of ['to', 'value', 'data', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'signatures']) {
    assert.notEqual(r[f], '', `${f} must be populated`);
  }
});

/* --------------------------------------------- guards, against the real record */

test('a real transaction is refused when the on-chain nonce has moved', () => {
  const r = assemble({ ...input(), onchainNonce: String(Number(FIXTURE.onchain.nonce) + 1) });
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-next-nonce');
});

test('a real transaction is refused when a real signer stops being an owner', () => {
  const dropped = FIXTURE.onchain.owners.filter(
    (o) => o.toLowerCase() !== candidate().confirmations[0].owner.toLowerCase());
  const r = assemble({ ...input(), onchainOwners: dropped });
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'owner-removed');
});

test('a real transaction is refused off-roster', () => {
  const r = assemble({ ...input(), roster: [] });
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-on-roster');
});
