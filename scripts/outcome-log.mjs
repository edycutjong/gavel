/**
 * gavel — scripts/outcome-log.mjs
 *
 * WHY THIS EXISTS. Every refusal in scripts/drain.mjs used to end at a
 * console.log and an exit code. That means the only durable record this project
 * produced was `docs/receipts-<chain>.json` — which, by construction, contains
 * nothing but successes: outcomes 1-7 are decided by the pure function BEFORE
 * anything is sent, so KeeperHub never sees them and its execution ledger cannot
 * show them.
 *
 * The effect was that the nine named outcomes were proven offline in `test/` and
 * were invisible online. A reader asking "does this survive conditions that are
 * not the happy path?" was handed unit tests plus a ledger of consecutive
 * successes. The unhappy path was asserted, never observed.
 *
 * This module gives every terminal state of a drain — refused, guarded, failed
 * precondition, dry, executed — one machine-readable row in an append-only log,
 * so the refusals are exactly as durable as the executions.
 *
 * NOT A REPLACEMENT for KeeperHub's ledger. `receipts-<chain>.json` stays the
 * authority on what KeeperHub actually executed; this log is the authority on
 * what gavel *decided*, which is a strictly larger set. Where they overlap
 * (executions) the executionId joins them.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The nine named outcomes plus the two guards, exactly as build/README.md lists
 * them. Kept here as data so a typo in a call site fails loudly instead of
 * quietly inventing an eleventh outcome that no test covers.
 */
export const TAXONOMY = Object.freeze({
  'not-next-nonce':       { n: 1, decidedBy: 'assemble', class: 'refusal' },
  'below-threshold':      { n: 2, decidedBy: 'assemble', class: 'refusal' },
  'eip1271-unsupported':  { n: 3, decidedBy: 'assemble', class: 'refusal' },
  'refund-requested':     { n: 4, decidedBy: 'assemble', class: 'refusal' },
  'delegatecall-refused': { n: 5, decidedBy: 'assemble', class: 'refusal' },
  'threshold-drift':      { n: 6, decidedBy: 'assemble', class: 'refusal' },
  'owner-removed':        { n: 7, decidedBy: 'assemble', class: 'refusal' },
  'raced-gs026':          { n: 8, decidedBy: 'chain',    class: 'refusal' },
  'inner-call-failed':    { n: 9, decidedBy: 'chain',    class: 'refusal' },
  'not-on-roster':        { n: null, decidedBy: 'assemble', class: 'guard' },
  'incomplete-payload':   { n: null, decidedBy: 'assemble', class: 'guard' },
  // The twelfth. build/README.md documents "nine named outcomes" plus two guards;
  // src/assemble.mjs also returns `malformed-payload` from nine call sites for
  // input that is not well-formed at all (a safeAddress that is not 20 bytes, a
  // non-integer nonce, an empty owner array). It is a real, reachable, distinct
  // reason and the README does not list it. Recorded here rather than folded into
  // another bucket, because collapsing it would hide the gap instead of showing it.
  'malformed-payload':    { n: null, decidedBy: 'assemble', class: 'guard' },
});

/**
 * Terminal states that are NOT part of the taxonomy: operational facts about a
 * run rather than judgements about a queued transaction. Kept separate so the
 * coverage table can never pad itself with plumbing.
 */
export const OPERATIONAL = Object.freeze({
  'safe-not-deployed':  'precondition',
  'tx-service-error':   'precondition',
  'eth-call-reverted':  'precondition',
  'preflight-failed':   'precondition',
  'executable-dry':     'execution',
  'executed':           'execution',
  'broadcast-no-hash':  'execution',
});

/**
 * Shape one row. Pure — no clock, no fs, no network — so the tests can assert
 * the whole schema without touching a disk or a chain. `at` is injected by the
 * caller for the same reason.
 */
export function shapeOutcome({
  at, chainId, safe, outcome, stage, detail = null,
  executionId = null, tx = null, queueCount = null,
  nonce = null, threshold = null, receiptsEligible = null,
}) {
  const known = TAXONOMY[outcome];
  const opClass = OPERATIONAL[outcome];
  if (!known && !opClass) {
    throw new Error(
      `outcome-log: "${outcome}" is neither one of the eleven named outcomes nor a known ` +
      `operational state. Add it to TAXONOMY or OPERATIONAL deliberately — do not let a ` +
      `call site invent one.`,
    );
  }
  return {
    at,
    chainId: String(chainId),
    safe,
    outcome,
    class: known ? known.class : opClass,
    taxonomyIndex: known ? known.n : null,
    decidedBy: known ? known.decidedBy : 'runner',
    stage,
    detail,
    executionId,
    tx,
    queueCount,
    nonce: nonce === null ? null : String(nonce),
    threshold: threshold === null ? null : String(threshold),
    receiptsEligible,
  };
}

/**
 * Append one row. JSON Lines, because a drain is one process per Safe and two
 * sweeps running side by side must not be able to corrupt each other's file the
 * way a read-modify-write of a JSON array would.
 */
export function record(row) {
  const shaped = shapeOutcome(row);
  const dir = join(ROOT, 'docs');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `outcomes-${shaped.chainId}.jsonl`), JSON.stringify(shaped) + '\n');
  return shaped;
}
