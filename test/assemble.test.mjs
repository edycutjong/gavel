import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assemble, REFUSALS, PRE_BROADCAST_REFUSALS } from '../src/assemble.mjs';
import {
  input, pendingTx, confirmation, sig,
  O1, O2, O3, O4, O5, SAFE, USDC_BASE, ZERO, ASCENDING,
} from './fixtures.mjs';

const strip = (s) => s.replace(/^0x/, '');

/* ------------------------------------------------------------------ happy path */

test('executes a threshold-met payout at the live nonce', () => {
  const r = assemble(input());
  assert.equal(r.executable, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.to, USDC_BASE);
  assert.equal(r.operation, 0);
  assert.equal(r.nonce, '41');
  assert.equal(r.onchainNonce, '41');
  assert.equal(r.threshold, 2);
  assert.equal(r.signerCount, 2);
  assert.equal(r.candidateCount, 1);
});

test('emits all ten execTransaction arguments', () => {
  const r = assemble(input());
  for (const f of ['to', 'value', 'data', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'signatures']) {
    assert.notEqual(r[f], '', `${f} must be populated`);
  }
  assert.equal(typeof r.operation, 'number');
  assert.equal(r.gasToken, ZERO);
  assert.equal(r.refundReceiver, ZERO);
});

/* ------------------------------------------------- I8 · canonical ordering */

test('I8 · concatenates signatures in ascending owner order, not queue order', () => {
  // fixture lists O2 before O1; ascending is O1 then O2
  const r = assemble(input());
  const expected = '0x' + strip(sig('01')) + strip(sig('20'));
  assert.equal(r.signatures, expected);
});

test('I8 · a 65-byte signature per required signer, and no more', () => {
  const r = assemble(input());
  assert.equal(strip(r.signatures).length, 2 * 130);
});

test('I8 · deduplicates a repeated signer rather than counting it twice', () => {
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), confirmation(O1)] },
  }));
  // one distinct signer against a threshold of 2
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'below-threshold');
  assert.equal(r.signerCount, 1);
});

test('I8 · takes exactly `threshold` signatures when more are available', () => {
  const r = assemble(input({
    tx: { confirmations: ASCENDING.map((o) => confirmation(o)) },
  }));
  assert.equal(r.executable, true);
  assert.equal(r.signerCount, 5);
  assert.equal(r.threshold, 2);
  assert.equal(strip(r.signatures).length, 2 * 130);
  // and they are the two LOWEST addresses, in ascending order
  assert.equal(r.signatures, '0x' + strip(sig('01')) + strip(sig('06')));
});

/* --------------------------------------------------------- I3 · the roster */

test('I3 · refuses a Safe that never opted in', () => {
  const r = assemble(input({ roster: ['0x2222222222222222222222222222222222222222'] }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-on-roster');
});

test('I3 · roster matching is case-insensitive', () => {
  // SAFE is all-1s, so upper/lowercasing it is a no-op and the old version of
  // this test compared a string to itself. Use a mixed-case address so the
  // assertion can actually fail if matching became case-sensitive.
  const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  assert.notEqual(mixed, mixed.toLowerCase(), 'fixture must be mixed-case to be meaningful');
  const r = assemble(input({ safeAddress: mixed, roster: [mixed.toLowerCase()] }));
  assert.notEqual(r.reason, 'not-on-roster');
});

/* -------------------------------------------------- I2 + I11 · the nonce */

test('I2 · refuses when no queued transaction sits at the live nonce', () => {
  const r = assemble(input({ onchainNonce: '42' }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-next-nonce');
  assert.equal(r.candidateCount, 0);
});

test('I11 · refuses when two different proposals share one nonce', () => {
  const r = assemble(input({
    queue: { transactions: [pendingTx(), pendingTx({ safeTxHash: '0xfeed' })], count: 2 },
  }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-next-nonce');
  assert.equal(r.candidateCount, 2);
  assert.match(r.detail, /2 different proposals/);
});

/* ------------------------------------------- payload completeness (pre-I4) */

for (const field of ['gasPrice', 'gasToken', 'refundReceiver', 'safeTxGas', 'baseGas']) {
  test(`refuses rather than assuming zero when ${field} is absent`, () => {
    const r = assemble(input({ tx: { [field]: undefined } }));
    assert.equal(r.executable, false);
    assert.equal(r.reason, 'incomplete-payload');
    assert.match(r.detail, new RegExp(field));
  });
}

/* ------------------------------------------------------ I5 · delegatecall */

test('I5 · refuses DELEGATECALL', () => {
  const r = assemble(input({ tx: { operation: 1 } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'delegatecall-refused');
});

/* ----------------------------------------------------------- I4 · refunds */

test('I4 · refuses a non-zero gasPrice', () => {
  const r = assemble(input({ tx: { gasPrice: '1' } }));
  assert.equal(r.reason, 'refund-requested');
});

test('I4 · refuses a non-zero gasToken', () => {
  const r = assemble(input({ tx: { gasToken: '0x000000000000000000000000000000000000dEaD' } }));
  assert.equal(r.reason, 'refund-requested');
});

test('I4 · refuses a non-zero refundReceiver', () => {
  const r = assemble(input({ tx: { refundReceiver: '0x000000000000000000000000000000000000dEaD' } }));
  assert.equal(r.reason, 'refund-requested');
});

/* ------------------------------------------- I7 · signature-set purity */

test('I7 · refuses an EIP-1271 contract signature', () => {
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), confirmation(O2, { signatureType: 'CONTRACT_SIGNATURE' })] },
  }));
  assert.equal(r.reason, 'eip1271-unsupported');
});

test('I7 · refuses an APPROVED_HASH confirmation', () => {
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), confirmation(O2, { signatureType: 'APPROVED_HASH' })] },
  }));
  assert.equal(r.reason, 'eip1271-unsupported');
});

test('I7 · refuses a signature that is not 65 bytes', () => {
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), confirmation(O2, { signature: '0xabcd' })] },
  }));
  assert.equal(r.reason, 'eip1271-unsupported');
});

/* ------------------------------------------------------ I6 · owner removed */

test('I6 · refuses a signature from an address that is no longer an owner', () => {
  const r = assemble(input({ onchainOwners: [O1, O3, O4, O5] })); // O2 removed
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'owner-removed');
  assert.match(r.detail, new RegExp(O2));
});

/* ------------------------------------------------------- I1 · the threshold */

test('I1 · refuses below threshold', () => {
  const r = assemble(input({ tx: { confirmations: [confirmation(O1)] } }));
  assert.equal(r.reason, 'below-threshold');
  assert.equal(r.signerCount, 1);
});

test('I1 · threshold-drift when the chain raised the bar after signing', () => {
  // queue still believes 2 is enough; chain now requires 3
  const r = assemble(input({ onchainThreshold: 3 }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'threshold-drift');
  assert.equal(r.threshold, 3);
});

test('I1 · trusts the higher of the cached and live thresholds', () => {
  const r = assemble(input({ onchainThreshold: 1 }));
  // queue says 2, chain says 1 -> required is 2, which we have
  assert.equal(r.executable, true);
  assert.equal(r.threshold, 2);
});

/* ------------------------------------------------------- I10 · code purity */

test('I10 · the code node performs no I/O', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/assemble.mjs', import.meta.url)), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [
    'fetch(', 'await ', 'require(', 'XMLHttpRequest', 'process.env',
    // added after review: the original list would not have caught any of these,
    // and each breaks either purity (I10) or determinism.
    'eval(', 'new Function(', 'import(', 'Math.random(', 'Date.now(', 'new Date(',
  ]) {
    assert.equal(body.includes(forbidden), false, `assemble.mjs must not contain ${forbidden}`);
  }
});

test('I10 · assemble is deterministic — same input, same output', () => {
  assert.deepEqual(assemble(input()), assemble(input()));
});

/* --------------------------------------------------------- the outcome set */

test('the committed refusal set is exactly nine', () => {
  assert.equal(REFUSALS.length, 9);
  assert.equal(PRE_BROADCAST_REFUSALS.length, 7);
  assert.equal(REFUSALS.includes('raced-gs026'), true);
  assert.equal(REFUSALS.includes('inner-call-failed'), true);
});

test('every pre-broadcast refusal this file can emit is in the committed set', () => {
  const emitted = new Set([
    assemble(input({ onchainNonce: '42' })).reason,
    assemble(input({ tx: { operation: 1 } })).reason,
    assemble(input({ tx: { gasPrice: '1' } })).reason,
    assemble(input({ tx: { confirmations: [confirmation(O1), confirmation(O2, { signatureType: 'CONTRACT_SIGNATURE' })] } })).reason,
    assemble(input({ onchainOwners: [O1, O3, O4, O5] })).reason,
    assemble(input({ tx: { confirmations: [confirmation(O1)] } })).reason,
    assemble(input({ onchainThreshold: 3 })).reason,
  ]);
  assert.equal(emitted.size, 7, 'all seven pre-broadcast refusals are reachable');
  for (const r of emitted) assert.equal(PRE_BROADCAST_REFUSALS.includes(r), true, `${r} is committed`);
});
