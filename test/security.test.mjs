/**
 * Regression tests for an adversarial review of 2026-09-02.
 *
 * Every case below was a WORKING EXPLOIT before it was a test. Three of eleven
 * invariants did not hold as written, and the generated workflow bypassed all of
 * them at once. They are grouped by the finding that produced them so a future
 * reader can see what the code used to do, not just what it now refuses.
 *
 * The rule these encode: a guard that reads an OPTIONAL, CALLER-SUPPLIED field is
 * not a guard. Check the bytes, or check nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/assemble.mjs';
import { input, confirmation, O1, O2 } from './fixtures.mjs';

/* ---- #2 · a threshold below 1 made an EMPTY signature blob executable ---- */

test('#2a · threshold 0 is refused, not treated as satisfied', () => {
  // Was: executable:true, signatures:"0x", threshold:0
  const r = assemble(input({ onchainThreshold: 0, tx: { confirmationsRequired: 0, confirmations: [] } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'malformed-payload');
});

test('#2b · a NEGATIVE threshold cannot slice the signature array from the end', () => {
  // Was the nastier half: signerCount(2) < -5 is false, then slice(0,-5) counts
  // backwards and yields [], so two real signatures became an empty blob with
  // executable:true. toBig accepted "-5" because BigInt does.
  const r = assemble(input({ onchainThreshold: -5, tx: { confirmationsRequired: '-5' } }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'malformed-payload');
});

test('#2c · a valid run never emits an empty blob while claiming ok', () => {
  const r = assemble(input());
  assert.equal(r.executable, true);
  assert.ok(r.signatures.length > 2, 'ok must never carry an empty signature blob');
  assert.equal((r.signatures.length - 2) / 2, r.threshold * 65);
});

/* ---- #3 · I7 rested on an optional label; the v byte is the real check ---- */

const sigWithV = (owner, v) => '0x' + owner.slice(2).padStart(64, '0') + '0'.repeat(64) + v;

test('#3a · APPROVED_HASH shape (v=0x01) is refused even with NO signatureType', () => {
  // An approved-hash signature is exactly 65 bytes and passed the shape check.
  // The type check read `signatureType`, which a hostile payload simply omits.
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), { owner: O2, signature: sigWithV(O2, '01') }] },
  }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'eip1271-unsupported');
});

test('#3b · EIP-1271 shape (v=0x00) is refused even with signatureType null', () => {
  // The dangerous one: checkSignatures reads `s` as an offset and CALLS the
  // address in `r`. An attacker-controlled external call inside execTransaction.
  const r = assemble(input({
    tx: { confirmations: [confirmation(O1), { owner: O2, signatureType: null, signature: sigWithV(O2, '00') }] },
  }));
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'eip1271-unsupported');
});

test('#3c · any v outside {27,28,31,32} is refused', () => {
  for (const v of ['00', '01', '02', '1a', '1d', 'ff']) {
    const r = assemble(input({
      tx: { confirmations: [confirmation(O1), { owner: O2, signature: '0x' + 'a'.repeat(128) + v }] },
    }));
    assert.equal(r.executable, false, `v=0x${v} must be refused`);
    assert.equal(r.reason, 'eip1271-unsupported');
  }
});

test('#3d · the four pass-through v values are still accepted', () => {
  // The guard must not be so tight it rejects real signatures. 27/28 are EIP-712,
  // 31/32 are eth_sign — the live fixture observed 31 and 32.
  for (const v of ['1b', '1c', '1f', '20']) {
    const r = assemble(input({
      tx: { confirmations: [
        { owner: O1, signature: '0x' + 'a'.repeat(128) + v },
        { owner: O2, signature: '0x' + 'b'.repeat(128) + v },
      ] },
    }));
    assert.equal(r.executable, true, `v=0x${v} must be accepted`);
  }
});

/* ---- #6 · I3 failed open on a falsy address + a falsy roster entry ---- */

test('#6a · a falsy safeAddress is refused, not matched against a falsy roster entry', () => {
  // lower() mapped undefined, null and "" all to "", so one stray "" in
  // roster.json matched a missing address and opened the gate.
  for (const bad of [undefined, null, '', '   ']) {
    const r = assemble({ ...input(), safeAddress: bad, roster: ['', null, '0x1111111111111111111111111111111111111111'] });
    assert.equal(r.executable, false, `safeAddress=${JSON.stringify(bad)} must refuse`);
    assert.equal(r.reason, 'malformed-payload');
  }
});

test('#6b · a roster of only falsy entries matches nothing', () => {
  const r = assemble({ ...input(), roster: ['', null, undefined, 0] });
  assert.equal(r.executable, false);
  assert.equal(r.reason, 'not-on-roster');
});

test('#6c · a non-address safeAddress is refused before any other guard', () => {
  const r = assemble({ ...input(), safeAddress: 'not-an-address' });
  assert.equal(r.reason, 'malformed-payload');
});

/* ---- #9 · malformed fields threw instead of producing a named outcome ---- */

test('#9 · garbage field values produce a NAMED refusal, never a throw', () => {
  // A thrown code node is an undeclared tenth outcome whose effect on the
  // downstream gate is untested. Every one of these used to throw.
  const cases = [
    ['safeTxGas', { safeTxGas: 'abc' }],
    ['value', { value: 'abc' }],
    ['gasPrice bool', { gasPrice: true }],
    ['to absent', { to: undefined }],
  ];
  for (const [label, tx] of cases) {
    let r;
    assert.doesNotThrow(() => { r = assemble(input({ tx })); }, `${label} must not throw`);
    assert.equal(r.executable, false, label);
  }
});

test('#9b · a null queue and a non-array owner set refuse rather than throw', () => {
  assert.doesNotThrow(() => {
    const a = assemble({ ...input(), queue: null });
    assert.equal(a.executable, false);
    const b = assemble({ ...input(), onchainOwners: null });
    assert.equal(b.executable, false);
    assert.equal(b.reason, 'malformed-payload');
  });
});

/* ---- #1 · the generated workflow spliced caller input into JS source ---- */

test('#1 · the generated code node never splices a template inside a string literal', () => {
  // The exploit: safeAddress closed the string literal and appended its own
  // `function assemble(){...}`, which hoists over the real one — bypassing every
  // guard at once. The fix is that the template is a JSON VALUE, unquoted.
  let src;
  try {
    src = readFileSync(fileURLToPath(new URL('../workflows/gavel-drain-11155111.json', import.meta.url)), 'utf8');
  } catch {
    return; // workflow not generated in this checkout; sync.mjs regenerates it
  }
  const code = JSON.parse(src).nodes.find((n) => n.id === 'assemble-1').data.config.code;
  assert.ok(code.includes('const __safeAddress = {{@trigger-1:Webhook.safeAddress}};'),
    'safeAddress must be substituted as a bare JSON value');
  assert.ok(!/["']\{\{@trigger-1:Webhook\.safeAddress\}\}["']/.test(code),
    'no template may sit inside a quoted string in the code body');
});
