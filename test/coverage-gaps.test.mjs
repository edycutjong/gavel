/**
 * Closes the branch-coverage gap left by assemble.test.mjs and security.test.mjs.
 *
 * `node --test --experimental-test-coverage` reports 98%+ LINE coverage well before
 * branch coverage catches up — a line can be "touched" while one of its two branches
 * (a `??` default, a ternary alternate, a `try/catch` that never actually throws)
 * never fires. Each test below exists because a specific branch in src/assemble.mjs
 * showed a zero count in `node --test --experimental-test-coverage`'s branch report,
 * not because the line was unexecuted. As with security.test.mjs, every case here
 * pins a NAMED refusal or a specific field in the assembled output — never just
 * "does not throw".
 *
 * One branch is deliberately absent from this file: assemble.mjs:370-372, guarded
 * by a comment stating it is asserted defensively and cannot be reached without
 * bypassing an earlier guard. See test/COVERAGE.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assemble } from '../src/assemble.mjs';
import { input, pendingTx, confirmation, sig, O1, O2, SAFE, ZERO } from './fixtures.mjs';

/* ---- assemble.mjs:96 · lower()'s `s ?? ''` default ---- */

test('#10 · a confirmation with no owner field at all is refused as owner-removed, not thrown', () => {
  // lower(c?.owner) must handle owner === undefined without throwing — the ?? ''
  // branch inside lower() only fires when a confirmation omits `owner` entirely,
  // which no other test in this suite does.
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), { signatureType: 'EOA', signature: sig('99') }] },
  }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'owner-removed');
});

/* ---- assemble.mjs:100 · toBig()'s literal-bigint fast path ---- */

test('#11 · a field supplied as a real bigint (not a string) is accepted verbatim', () => {
  // toBig has an explicit `typeof value === 'bigint'` branch. Every fixture in this
  // suite hands numeric fields in as strings or numbers, so that branch was never
  // exercised even though the function contract explicitly documents accepting it.
  const r = assemble(input({ tx: { value: 10n } }));
  assert.equal(r.executable, true);
  assert.equal(r.value, '10');
});

/* ---- assemble.mjs:102 · toBig()'s "unsafe number" throw ---- */

test('#12 · a non-integer onchainThreshold is refused as malformed-payload, not coerced', () => {
  // Number.isSafeInteger(1.5) is false — distinct from toCount's own explicit
  // range check (see security.test.mjs #2b, which uses an out-of-range integer).
  // This is the only way to reach toBig's "unsafe number" throw.
  const r = assemble(input({ onchainThreshold: 1.5 }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'malformed-payload');
  assert.match(r.detail, /onchainThreshold/);
});

/* ---- assemble.mjs:107 · toBig()'s "empty" throw on a whitespace-only string ---- */

test('#13 · a whitespace-only tx.value is refused as malformed-payload, not treated as zero', () => {
  // "value" is not one of the five HYDRATED_FIELDS, so it slips past incomplete-
  // payload and reaches toBig's string branch, where trim() reduces it to "".
  const r = assemble(input({ tx: { value: '   ' } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'malformed-payload');
  assert.match(r.detail, /value/);
});

/* ---- assemble.mjs:117-119 · isZeroAddress()'s catch (toBig throws on garbage) ---- */

test('#14a · a non-hex gasToken trips isZeroAddress\'s catch and refuses as refund-requested', () => {
  // toBig("not-a-token") throws a SyntaxError out of BigInt(); isZeroAddress must
  // catch it and treat "I could not parse this" as "not zero" — fail closed, same
  // outcome as a genuinely hostile gasToken.
  const r = assemble(input({ tx: { gasToken: 'not-a-token' } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'refund-requested');
});

test('#14b · a non-hex refundReceiver trips isZeroAddress\'s catch and refuses as refund-requested', () => {
  const r = assemble(input({ tx: { refundReceiver: 'also-not-an-address' } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'refund-requested');
});

/* ---- assemble.mjs:145-147 & 366 · toCount()'s catch, and its `?? thresholdOnchain` fallback ---- */

test('#15 · a garbage confirmationsRequired falls back to the on-chain threshold rather than refusing', () => {
  // toCount({}) throws inside toBig (typeof object) and toCount's own catch turns
  // that into null; `toCount(tx.confirmationsRequired) ?? thresholdOnchain` then
  // falls back to the live on-chain read. Two real signatures against an on-chain
  // threshold of 2 must still execute — an unusable cached threshold is not treated
  // as a reason to refuse when the on-chain read alone is sufficient.
  const r = assemble(input({ tx: { confirmationsRequired: {} } }));
  assert.equal(r.executable, true);
  assert.equal(r.threshold, 2);
  assert.equal(r.signerCount, 2);
});

/* ---- assemble.mjs:184 · assemble()'s `input ?? {}` default ---- */

test('#16 · assemble(undefined) refuses as malformed-payload instead of throwing', () => {
  assert.doesNotThrow(() => {
    const r = assemble(undefined);
    assert.equal(r.executable, false);
    assert.equal(r.reason, 'malformed-payload');
  });
});

/* ---- assemble.mjs:197 & 205-207 · toCount(onchainNonce) failing ---- */

test('#17 · a non-numeric onchainNonce is refused as malformed-payload', () => {
  // BigInt("not-a-nonce") throws inside toBig's string branch; toCount's catch
  // turns that into null, which is refused here rather than compared against the
  // queue as if it were a real nonce.
  const r = assemble(input({ onchainNonce: 'not-a-nonce' }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'malformed-payload');
  assert.match(r.detail, /onchainNonce/);
  // the provenance block must still report an empty nonce, not throw formatting it
  assert.equal(r.onchainNonce, '');
});

/* ---- assemble.mjs:225 · the roster falling back to [] when it is not an array ---- */

test('#18 · a non-array roster (not just falsy entries) matches nothing rather than throwing', () => {
  // security.test.mjs #6b covers a roster that IS an array of only falsy entries.
  // This covers the roster itself failing Array.isArray — e.g. a caller-supplied
  // object instead of a list.
  const r = assemble({ ...input(), roster: null });
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-on-roster');
});

/* ---- assemble.mjs:262 · withNonce's `tx.safeTxHash ?? ''` default ---- */

test('#19 · an executable result with no safeTxHash on the queued tx reports an empty one, not "undefined"', () => {
  const r = assemble(input({ tx: { safeTxHash: undefined } }));
  assert.equal(r.executable, true);
  assert.equal(r.safeTxHash, '');
});

/* ---- assemble.mjs:277 · operation's `tx.operation ?? 0` default ---- */

test('#20 · an executable result with no operation field on the queued tx defaults to CALL (0)', () => {
  const r = assemble(input({ tx: { operation: undefined } }));
  assert.equal(r.executable, true);
  assert.equal(r.operation, 0);
});

/* ---- assemble.mjs:308 · confirmations falling back to [] when not an array ---- */

test('#21 · a non-array confirmations list is treated as zero signers, not thrown', () => {
  const r = assemble(input({ tx: { confirmations: null } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'below-threshold');
  assert.equal(r.signerCount, 0);
});

/* ---- assemble.mjs:394 & 408 · the value/safeTxGas/baseGas loop's `tx[f] ?? 0` default ---- */

test('#22 · an executable result with no value field on the queued tx defaults to 0', () => {
  const r = assemble(input({ tx: { value: undefined } }));
  assert.equal(r.executable, true);
  assert.equal(r.value, '0');
});

/* ---- assemble.mjs:409 · data's `tx.data ?? '0x'` default, and its `|| '0x'` fallback ---- */

test('#23a · an executable result with no data field on the queued tx defaults to "0x"', () => {
  const r = assemble(input({ tx: { data: undefined } }));
  assert.equal(r.executable, true);
  assert.equal(r.data, '0x');
});

test('#23b · an executable result with an EXPLICITLY EMPTY data string still emits "0x", not ""', () => {
  // "" is not nullish, so `tx.data ?? '0x'` keeps it; only the trailing `|| '0x'`
  // catches this case. Distinct branch from #23a.
  const r = assemble(input({ tx: { data: '' } }));
  assert.equal(r.executable, true);
  assert.equal(r.data, '0x');
});
