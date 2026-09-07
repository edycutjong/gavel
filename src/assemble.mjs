/**
 * gavel — src/assemble.mjs
 *
 * THE ENTIRE DECISION SURFACE. Given one Safe's off-chain queue plus three live
 * on-chain reads, decide whether exactly one queued transaction may be executed,
 * and if so produce the ten `execTransaction` arguments ready to splice into a
 * `web3/write-contract` call.
 *
 * CONTRACT
 *   - Pure. Zero I/O: no fetch, no await, no network, no clock, no randomness.
 *     `fetch` IS available in the KeeperHub sandbox — not using it is a deliberate
 *     refusal (invariant I10), because a pure function is testable offline against
 *     real fixtures and an impure one is not.
 *   - Zero dependencies. This file is injected verbatim into the workflow JSON by
 *     scripts/sync.mjs, so it must run byte-identically inside the sandbox, where
 *     the only crypto primitive exposed is `crypto.randomUUID`.
 *   - No hashing. No keccak256, no EIP-712 domain, no abi.encode, no safeTxHash
 *     derivation. `execTransaction` recomputes the hash itself from the ten args;
 *     the Transaction Service already holds each owner's signature bytes.
 *
 * v-NORMALISATION IS DELIBERATELY NOT IMPLEMENTED.
 * The Transaction Service stores each signature exactly as the signing client
 * produced it, and Safe's own SDK/UI already writes v = 27/28 (EIP-712) and
 * v = 31/32 (eth_sign) — precisely what `checkSignatures` expects. Pass-through is
 * correct; ADDING normalisation would be the bug. Only SPIKE P4 (byte-comparing our
 * blob against one the Safe UI submits for the same queued tx) can change this.
 */

/** The nine named outcomes. Every non-execution resolves to exactly one of these. */
export const REFUSALS = Object.freeze([
  'not-next-nonce',
  'below-threshold',
  'eip1271-unsupported',
  'refund-requested',
  'delegatecall-refused',
  'threshold-drift',
  'owner-removed',
  // assigned post-broadcast by scripts/audit.mjs, never by this file:
  'raced-gs026',
  'inner-call-failed',
]);

/** Refusals this file can produce (the seven pre-broadcast ones). */
export const PRE_BROADCAST_REFUSALS = Object.freeze(REFUSALS.slice(0, 7));

/**
 * Security guards that are NOT among the nine judged outcomes.
 *
 * Both exist because a guard whose correct behaviour is "never fires in
 * production" still must not fall through to execution. Neither is a demo
 * outcome and neither is counted toward M2's 9-of-9.
 *
 *   not-on-roster      invariant I3, re-checked here because the first check
 *                      (roster-1) is bypassable by anyone who can call the
 *                      public Marketplace listing. THIS is the check that matters.
 *
 *   incomplete-payload the plugin's projection omits safeTxGas, baseGas, gasPrice,
 *                      gasToken and refundReceiver (verified live 2026-09-02 —
 *                      see specs/spike-results.md). When hydrate-1 has not supplied
 *                      them we CANNOT evaluate I4, and defaulting them to zero
 *                      would silently disarm the single most dangerous guard in the
 *                      design. Refuse instead.
 */
export const SECURITY_REFUSALS = Object.freeze([
  'not-on-roster', 'incomplete-payload', 'malformed-payload',
]);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Signature types we refuse outright (invariant I7). */
const REFUSED_SIGNATURE_TYPES = Object.freeze(['CONTRACT_SIGNATURE', 'APPROVED_HASH']);

/**
 * The ONLY `v` values checkSignatures treats as an ECDSA signature.
 *   27/28 — EIP-712 (eth_signTypedData)
 *   31/32 — eth_sign, i.e. 27/28 + 4
 *
 * Everything else is a different scheme wearing 65 bytes:
 *   v = 0  CONTRACT_SIGNATURE. `s` is an offset into the blob and `r` is a
 *          contract address that checkSignatures CALLS (EIP-1271). That is an
 *          attacker-controlled external call from inside execTransaction.
 *   v = 1  APPROVED_HASH. `r` is an owner address and no signature is verified.
 *
 * I7 previously refused these by reading `signatureType`, a field the service
 * supplies and an attacker-fed payload can simply omit. This set is checked on
 * the BYTES, which cannot be omitted.
 */
const PASSTHROUGH_V = Object.freeze([27, 28, 31, 32]);

/** The five fields the Safe plugin does not return; hydrate-1 must supply them. */
const HYDRATED_FIELDS = Object.freeze([
  'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver',
]);

const lower = (s) => String(s ?? '').trim().toLowerCase();

/** Parse a decimal or 0x-prefixed integer. Throws rather than guessing. */
function toBig(value, field) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${field}: unsafe number`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') throw new TypeError(`${field}: empty`);
    return BigInt(s);
  }
  throw new TypeError(`${field}: expected integer-like, got ${typeof value}`);
}

/** True when an address field is the zero address, accepting "0x0" and padded forms. */
function isZeroAddress(value) {
  try {
    return toBig(value, 'address') === 0n;
  } catch {
    return false;
  }
}

/** A 65-byte ECDSA signature: "0x" + 130 hex characters. */
function isWellFormedSignature(sig) {
  return typeof sig === 'string' && /^0x[0-9a-fA-F]{130}$/.test(sig.trim());
}

/** The trailing byte of a 65-byte signature, as a number. */
function signatureV(sig) {
  return parseInt(String(sig).trim().slice(-2), 16);
}

/**
 * A non-negative count, or null when the value is not one.
 *
 * `toBig` accepts "-5" happily, because BigInt does. A negative threshold made
 * `signerCount < required` false and then `slice(0, -5)` counted from the END and
 * returned an empty array — producing `executable: true` with an EMPTY signature
 * blob. Counts get their own parser so that cannot recur.
 */
function toCount(value) {
  try {
    const n = toBig(value, 'count');
    if (n < 0n || n > 1000n) return null;
    return Number(n);
  } catch {
    return null;
  }
}

function refuse(reason, detail, provenance = {}) {
  return {
    executable: false,
    reason,
    detail,
    to: '', value: '', data: '', operation: 0,
    safeTxGas: '', baseGas: '', gasPrice: '', gasToken: '', refundReceiver: '',
    signatures: '',
    safeTxHash: '',
    nonce: '', onchainNonce: '',
    signerCount: 0, threshold: 0,
    queueDepth: 0, candidateCount: 0,
    ...provenance,
  };
}

/**
 * @param {object} input
 * @param {string}   input.safeAddress      the Safe this run targets
 * @param {string[]} input.roster           opt-in list embedded by sync.mjs (I3)
 * @param {object}   input.queue            safe/get-pending-transactions output, optionally hydrated
 * @param {string|number} input.onchainNonce      safe/get-nonce
 * @param {string|number} input.onchainThreshold  safe/get-threshold
 * @param {string[]} input.onchainOwners     safe/get-owners
 * @returns {object} the Assembled contract described at the top of this file
 */
export function assemble(input) {
  const {
    safeAddress,
    roster = [],
    queue = {},
    onchainNonce,
    onchainThreshold,
    onchainOwners = [],
  } = input ?? {};

  // ---- input validation ----------------------------------------------------
  // Every guard below assumes well-formed inputs. Rather than trusting that, the
  // malformed cases become a NAMED refusal here. Previously several of them threw
  // out of the function instead, which in the workflow is an errored Code node —
  // an undeclared tenth outcome whose effect on the downstream gate is untested.
  const transactions = Array.isArray(queue?.transactions) ? queue.transactions : [];
  const queueDepth = transactions.length;

  const nonceOnchain = toCount(onchainNonce);
  const thresholdOnchain = toCount(onchainThreshold);
  const base = {
    onchainNonce: nonceOnchain === null ? '' : String(nonceOnchain),
    threshold: thresholdOnchain ?? 0,
    queueDepth,
  };

  if (!ADDRESS_RE.test(String(safeAddress ?? ''))) {
    return refuse('malformed-payload', `safeAddress ${safeAddress} is not a 20-byte address.`, base);
  }
  if (nonceOnchain === null) {
    return refuse('malformed-payload', `onchainNonce ${onchainNonce} is not a valid count.`, base);
  }
  // A threshold of 0 is not a Safe. Treating it as one made an EMPTY signature
  // blob executable, which is the failure this check exists for.
  if (thresholdOnchain === null || thresholdOnchain < 1) {
    return refuse('malformed-payload', `onchainThreshold ${onchainThreshold} is not >= 1.`, base);
  }
  if (!Array.isArray(onchainOwners) || onchainOwners.length === 0) {
    return refuse('malformed-payload', 'onchainOwners is empty or not an array.', base);
  }
  const owners = onchainOwners.map(lower);

  // ---- I3 · roster ---------------------------------------------------------
  // Checked here and not only in roster-1, because the Marketplace listing is a
  // caller-open door and roster-1 is bypassable through it.
  //
  // Falsy entries are filtered BEFORE the membership test. lower() maps undefined,
  // null and "" all to "", so a single stray "" in roster.json used to match a
  // missing safeAddress and open the gate for every run.
  const rosterSet = (Array.isArray(roster) ? roster : [])
    .filter((a) => ADDRESS_RE.test(String(a ?? '')))
    .map(lower);
  if (!rosterSet.includes(lower(safeAddress))) {
    return refuse(
      'not-on-roster',
      `Safe ${safeAddress} is not on the opt-in roster; refusing to execute against it.`,
      { ...base, candidateCount: 0 },
    );
  }

  // ---- I2 + I11 · exactly one candidate at the live nonce -------------------
  // The service permits two DIFFERENT proposals at one nonce — that is how
  // "replace transaction" works. Choosing between them is a policy call gavel is
  // not entitled to make, so two candidates refuses just as firmly as zero.
  const candidates = transactions.filter((tx) => toCount(tx?.nonce) === nonceOnchain);
  const candidateCount = candidates.length;
  const prov = { ...base, candidateCount };

  if (candidateCount === 0) {
    return refuse(
      'not-next-nonce',
      `No queued transaction at the live nonce ${nonceOnchain} (queue depth ${queueDepth}).`,
      prov,
    );
  }
  if (candidateCount > 1) {
    // A dedicated "nonce-conflict" reason is deliberately not split out yet; until it is, this
    // folds into not-next-nonce and carries candidateCount in detail.
    return refuse(
      'not-next-nonce',
      `${candidateCount} different proposals share nonce ${nonceOnchain}; choosing between them is not gavel's call.`,
      prov,
    );
  }

  const tx = candidates[0];
  const withNonce = { ...prov, nonce: String(toCount(tx.nonce)), safeTxHash: String(tx.safeTxHash ?? '') };

  // ---- payload completeness (precondition for I4) --------------------------
  const missing = HYDRATED_FIELDS.filter((f) => tx[f] === undefined || tx[f] === null || tx[f] === '');
  if (missing.length > 0) {
    return refuse(
      'incomplete-payload',
      `Missing ${missing.join(', ')} — cannot verify the refund guard, so refusing rather than assuming zero.`,
      withNonce,
    );
  }

  // ---- I5 · never delegatecall --------------------------------------------
  // operation == 1 can rewrite the Safe's own storage: owners, threshold,
  // singleton. We will not delegatecall someone's treasury on a schedule.
  const operation = Number(toBig(tx.operation ?? 0, 'tx.operation'));
  if (operation !== 0) {
    return refuse(
      'delegatecall-refused',
      `operation=${operation} is a DELEGATECALL; gavel executes CALL only.`,
      withNonce,
    );
  }

  // ---- I4 · never execute a refund transaction ----------------------------
  // The worst outcome in the design: execTransaction pays the refund from the
  // Safe to refundReceiver and CALLS gasToken, so a hostile token can re-enter.
  // The party this is aimed at is whoever executes — us.
  // Parsed fail-closed: an unparseable gasPrice is refused rather than thrown.
  // This is the guard against the drain vector, so "I could not read it" and
  // "it was hostile" must reach the same outcome.
  let gasPrice = null;
  try { gasPrice = toBig(tx.gasPrice, 'tx.gasPrice'); } catch { gasPrice = null; }
  if (gasPrice === null) {
    return refuse('malformed-payload',
      `gasPrice="${tx.gasPrice}" is not integer-like; refusing rather than assuming zero.`, withNonce);
  }
  if (gasPrice !== 0n || !isZeroAddress(tx.gasToken) || !isZeroAddress(tx.refundReceiver)) {
    return refuse(
      'refund-requested',
      `Refund parameters set (gasPrice=${gasPrice}, gasToken=${tx.gasToken}, refundReceiver=${tx.refundReceiver}); refusing — this is a drain vector aimed at the executor.`,
      withNonce,
    );
  }

  // ---- I7 · signature-set purity ------------------------------------------
  const confirmations = Array.isArray(tx.confirmations) ? tx.confirmations : [];
  const impure = confirmations.find((c) => REFUSED_SIGNATURE_TYPES.includes(String(c?.signatureType ?? '').toUpperCase()));
  if (impure) {
    return refuse(
      'eip1271-unsupported',
      `Confirmation from ${impure.owner} is ${impure.signatureType}; gavel splices EOA/eth_sign signatures only.`,
      withNonce,
    );
  }

  const malformed = confirmations.find((c) => !isWellFormedSignature(c?.signature));
  if (malformed) {
    return refuse(
      'eip1271-unsupported',
      `Confirmation from ${malformed.owner} is not a 65-byte ECDSA signature; refusing to splice it.`,
      withNonce,
    );
  }

  // The check that actually holds. signatureType is an OPTIONAL off-chain label and
  // a hostile payload simply omits it; v is in the bytes and cannot be. v=0 is an
  // EIP-1271 contract signature, where checkSignatures CALLS the address in `r` --
  // an attacker-controlled external call from inside execTransaction. v=1 is an
  // approved-hash, where nothing is verified at all. Both are exactly 65 bytes.
  const badV = confirmations.find((c) => !PASSTHROUGH_V.includes(signatureV(c.signature)));
  if (badV) {
    const v = signatureV(badV.signature);
    return refuse(
      'eip1271-unsupported',
      `Confirmation from ${badV.owner} has v=${v}; only EOA/eth_sign (27, 28, 31, 32) are spliced.`,
      withNonce,
    );
  }

  // ---- I6 · every confirming owner is STILL an owner ----------------------
  // The silent GS026: a signature collected legitimately last week from an owner
  // removed yesterday. Naive tooling broadcasts it.
  const removed = confirmations.find((c) => !owners.includes(lower(c?.owner)));
  if (removed) {
    return refuse(
      'owner-removed',
      `${removed.owner} signed but is no longer an owner of this Safe; the signature set is stale.`,
      withNonce,
    );
  }

  // ---- I8 · canonical ordering, deduplicated ------------------------------
  // checkSignatures walks currentOwner > lastOwner, so wrong order or a duplicate
  // signer is indistinguishable from a forgery and reverts GS026.
  const byOwner = new Map();
  for (const c of confirmations) byOwner.set(lower(c.owner), c);
  const distinct = [...byOwner.values()].sort((a, b) => (lower(a.owner) < lower(b.owner) ? -1 : 1));
  const signerCount = distinct.length;
  const withSigners = { ...withNonce, signerCount };

  // ---- I1 · never execute below threshold ---------------------------------
  // Required is the MAX of the queue's cached value and the live on-chain read;
  // trusting the cached one alone is the silent failure this guard exists for.
  const thresholdQueue = toCount(tx.confirmationsRequired) ?? thresholdOnchain;
  const required = Math.max(thresholdQueue, thresholdOnchain);
  // thresholdOnchain is already >= 1, so required is too. Asserted anyway: this is
  // the line whose absence made an empty blob executable, and it costs nothing.
  /* node:coverage ignore next 3 */
  if (!Number.isInteger(required) || required < 1) {
    return refuse('malformed-payload', `computed threshold ${required} is not >= 1.`, withSigners);
  }

  if (signerCount < required) {
    // Distinguish a plain shortfall from the drift case, where the queue believed
    // the transaction was ready and the chain disagrees.
    const reason = signerCount >= thresholdQueue && thresholdOnchain > thresholdQueue
      ? 'threshold-drift'
      : 'below-threshold';
    const detail = reason === 'threshold-drift'
      ? `Threshold was raised to ${thresholdOnchain} on-chain after signing; the queue still believes ${thresholdQueue} is enough.`
      : `${signerCount} of ${required} required signatures present.`;
    return refuse(reason, detail, withSigners);
  }

  // Exactly `required` signatures, ascending — checkSignatures needs no more.
  if (!ADDRESS_RE.test(String(tx.to ?? ''))) {
    return refuse('malformed-payload', `to ${tx.to} is not a 20-byte address.`, withSigners);
  }
  // Every remaining field is coerced below. Any that is not integer-like would
  // throw out of the function and become an errored code node rather than a named
  // outcome, so they are checked here while a refusal is still possible.
  for (const f of ['value', 'safeTxGas', 'baseGas']) {
    try { toBig(tx[f] ?? 0, f); } catch {
      return refuse('malformed-payload', `${f}="${tx[f]}" is not integer-like.`, withSigners);
    }
  }

  const chosen = distinct.slice(0, required);
  const signatures = '0x' + chosen.map((c) => c.signature.trim().replace(/^0x/, '')).join('');

  return {
    executable: true,
    reason: 'ok',
    detail: `Executing nonce ${withNonce.nonce} with ${required} of ${signerCount} signatures.`,

    to: String(tx.to),
    value: toBig(tx.value ?? 0, 'tx.value').toString(),
    data: String(tx.data ?? '0x') || '0x',
    operation,
    safeTxGas: toBig(tx.safeTxGas, 'tx.safeTxGas').toString(),
    baseGas: toBig(tx.baseGas, 'tx.baseGas').toString(),
    gasPrice: gasPrice.toString(),
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    signatures,

    safeTxHash: withNonce.safeTxHash,
    nonce: withNonce.nonce,
    onchainNonce: base.onchainNonce,
    signerCount,
    threshold: required,
    queueDepth,
    candidateCount,
  };
}

export default assemble;
