/**
 * Shared fixture builders.
 *
 * Owner addresses are the REAL derived cast (m/44'/60'/0'/0/{0..6}) that the
 * mainnet Safes use — see specs/cast.md. The signature BYTES are synthetic:
 * assemble.mjs performs no ecrecover and no hashing, so
 * what it verifies about a signature is its shape, not its provenance. Any test
 * that needs a genuine signature belongs in the on-chain path, not here.
 *
 * Deliberately note the insertion order below: O2 is listed before O1 and O3.
 * Ascending-by-owner is O1 < O3 < O2 < O5 < O4, so a fixture that happens to be
 * pre-sorted would let invariant I8 pass by accident.
 */

export const O1 = '0x019db835770D29FEd0E96071A59Ed812DFEC0c4a';
export const O2 = '0x20A5EdcDB3bf0587545De423cdd8Ba94c7D0D754';
export const O3 = '0x0644D5a2b729C3A4D0c5ee9337f29812522492Cf';
export const O4 = '0xb106572e189e79fF3B8f9D176470691313aBABb8';
export const O5 = '0x433B0dE89B1229B45e8F7ceCE6158ce2040dc8cb';
export const PAYEE = '0x660295C3f3EB0D65cac00521DD393a5184E405B1';
export const ATTACKER = '0xA4dc630f7240e2D3bA2cc594401c6d11CF8F65f5';

export const SAFE = '0x1111111111111111111111111111111111111111';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ZERO = '0x0000000000000000000000000000000000000000';

/** Ascending-by-lowercase order of the five owners. Referenced by the I8 test. */
export const ASCENDING = [O1, O3, O2, O5, O4];

/** A shape-valid 65-byte signature ending in v=27 (0x1b), tagged per owner. */
export function sig(tag, v = '1b') {
  return '0x' + String(tag).repeat(2).padEnd(128, '0').slice(0, 128) + v;
}

export function confirmation(owner, { signatureType = 'EOA', signature } = {}) {
  return {
    owner,
    signatureType,
    signature: signature ?? sig(owner.slice(2, 4)),
  };
}

/** A fully-hydrated, threshold-met, executable USDC payout at nonce 41. */
export function pendingTx(overrides = {}) {
  return {
    safeTxHash: '0xdeadbeef',
    to: USDC_BASE,
    value: '0',
    data: '0xa9059cbb',
    operation: 0,
    nonce: '41',
    confirmationsRequired: 2,
    // the five fields the Safe plugin omits; hydrate-1 supplies them
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
    confirmations: [confirmation(O2), confirmation(O1)],
    ...overrides,
  };
}

/** Default happy-path input: on the roster, nonce matches, 2-of-5. */
export function input(overrides = {}) {
  const { tx, ...rest } = overrides;
  return {
    safeAddress: SAFE,
    roster: [SAFE],
    queue: { transactions: [pendingTx(tx)], count: 1 },
    onchainNonce: '41',
    onchainThreshold: 2,
    onchainOwners: [O1, O2, O3, O4, O5],
    ...rest,
  };
}
