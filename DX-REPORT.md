# gavel — developer experience report

Friction encountered building gavel against KeeperHub, logged as it happened, with
reproductions. Every entry is dated and reproducible; nothing here is a guess.

> **SEND-BY: 2026-09-12.** Recorded the hour this file was created (2026-09-02).
> This document is worthless unread. In the previous KeeperHub edition we wrote seven
> findings, three issue drafts and one complete PR against the correct base branch and
> **filed none of them**; both UX bounties went to the field's #1 and #2 upstream
> contributors. This file gets sent whether or not it feels finished.

**Environment:** KeeperHub MCP server (`app.keeperhub.com/mcp`), org schema snapshot
`2026-09-02T06:34:21Z`, Base mainnet 8453, Node 22.22.0.

---

## DX-1 · `safe/get-pending-transactions` omits five of the ten `execTransaction` arguments

**Severity:** high — it is the difference between the Safe plugin being sufficient and
being a partial projection.
**Date:** 2026-09-02

The action's documented output is:

> *"Array of pending transactions with safeTxHash, to, value, data, operation, nonce,
> confirmations, confirmationsRequired, dataDecoded, and submissionDate"*

`execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken,
refundReceiver, signatures)` takes ten. The projection supplies `to`, `value`, `data`,
`operation` — and omits **`safeTxGas`, `baseGas`, `gasPrice`, `gasToken`,
`refundReceiver`**.

**Why this matters beyond convenience.** `gasToken` and `refundReceiver` are not
cosmetic: `execTransaction` pays a refund from the Safe to `refundReceiver` and *calls*
`gasToken`. A hostile pair is a drain vector aimed precisely at whoever executes. A
consumer that cannot see those fields cannot refuse them, and the natural workaround —
defaulting them to zero — silently disarms the check. gavel refuses with
`incomplete-payload` rather than assume (`src/assemble.mjs`), but the safe default should
not be left to each consumer to rediscover.

**Suggested fix:** pass the five fields through from the Transaction Service response;
they are already present upstream. Failing that, document the omission on the action page
with an explicit warning against zero-defaulting.

**Workaround in use:** a raw `HTTP Request` node against
`https://api.safe.global/tx-service/base/api/v2/`, which returns the full object.

---

## DX-2 · `get_spending_limits` does not expose the execution-count quota

**Severity:** medium — it is the metric capacity planning actually needs.
**Date:** 2026-09-02

The tool is described as returning "the organization's daily direct-execution spending
caps and current usage". It returns gas-denominated caps:

```json
{ "dailyCapWei": null, "dailyUsedWei": "0",
  "effectiveDailyCapWei": "20000000000000000", "usingDefaultDailyCap": true }
```

The docs separately state that a **monthly execution quota** exists, and no endpoint or
MCP tool appears to surface its value or current consumption. For a scheduled workflow the
binding constraint is runs, not wei: a 10-minute sweep is ~4,320 executions/month before
it does any work, while the gas cap above is non-binding by two orders of magnitude on
Base (0.006 gwei ⇒ ~20,000 `execTransaction` calls/day within 0.02 ETH).

Planning a volume run therefore requires guessing at the one number that can stop it.

**Suggested fix:** add `monthlyExecutionQuota` / `monthlyExecutionsUsed` to the same
response, or a sibling tool. The naming is also worth a look — "spending limits" reads as
covering all metering, which is how it was initially misread here.

**Credit where due:** `dailyCapWei: null` is correctly documented as "no org-set cap, the
platform default applies" rather than "unlimited". That note prevented a real
misconfiguration and is the kind of documentation the above is missing.

---

## DX-3 · `isManaged` on a web3 integration does not say what it manages

**Severity:** low — a documentation/naming issue, not a bug.
**Date:** 2026-09-02 · **Status: needs confirmation before filing.**

`list_integrations` returns `isManaged: false` for our org's web3 integration, while the
platform metadata elsewhere describes wallets as `"provider": "Turnkey", "features":
["secure-enclave", "non-custodial", "hosted"]`. Read together, `isManaged: false` invites
the conclusion "this is an imported key, not a Turnkey wallet" — which appears to be the
wrong reading, since the org Turnkey wallet is provisioned automatically and is the only
wallet an organization has.

The consequence of the misreading is not trivial: a project that concludes it is *not* on
Turnkey will either avoid claiming enclave custody it actually has, or claim it and be
wrong. Neither is good.

**Suggested fix:** document what `isManaged` refers to on the integration object, or rename
it to something scoped to the record rather than the custody model.

**Before filing:** confirm against Settings > Organization > Wallets that the address in
the integration is the provisioned org Turnkey wallet. If it is, this is the finding as
written. If it is not, the finding is different and stronger.

---

## DX-4 · No supported way to opt out of gas sponsorship when on-chain provenance is the point

**Severity:** high — it silently changes what a transaction proves.
**Date:** 2026-09-02

Per `wallet-management/gas`, a write is sponsored when four conditions all hold: supported
network, direct wallet sender (no Safe), public mempool, and gas credits available. On Base
with a plain wallet sender, all four are the default, so **sponsorship is the default path**.

Per `wallet-management/onchain-appearance`, a sponsored write is submitted by a relayer:
`From` is an address the user does not recognise, `To` is a contract they do not recognise,
and the user's own action becomes an internal call. The docs are admirably explicit about
the consequence:

> *"Do not verify by opening your wallet address and looking through its transaction list. A
> sponsored transaction was not sent by your wallet, so it does not appear there."*

That is the correct behaviour for the common case, and the documentation for it is genuinely
good. But there is a class of application where **the identity of the top-level sender is
the product**, not an implementation detail:

- an executor whose entire claim is *"this address, which owns nothing, submitted this call"*
- any keeper or relayer whose users audit it by watching one address
- anything whose evidence is "open this address on the explorer and count"

For those, the sponsored shape does not merely look unfamiliar — it erases the artifact. And
there appears to be **no per-workflow, per-node, or per-organization documented way to say
"send this one directly, I will pay the gas."** The only levers are indirect: exhaust the
gas-credit cap (uncontrolled, and it flips mid-run), or route through a Safe as Sender
(which changes `msg.sender`, a different and worse side effect).

**Suggested fix:** an explicit `sponsorship: "auto" | "never"` field on write actions, or an
organization-level toggle. `"never"` is a one-line policy check against the existing
four-condition test, and it makes on-chain provenance a supported use case rather than
something achieved by accident.

**Why it matters commercially:** sponsorship is metered against a monthly credit cap, so
users who opt out are cheaper to serve, not more expensive.

**Current status:** unresolved. gavel needs the direct shape and does not have a supported
way to guarantee it.

---

## DX-5 · `chainId` is documented as canonical and rejected at runtime

**Severity:** medium — it fails closed, but it contradicts the platform's own schema tips.
**Date:** 2026-09-02

`GET /api/mcp/schemas` returns this under `tips`:

> *"chainId is the canonical field for the target chain (e.g. 1 for Ethereum mainnet, … 8453 for
> Base). Accepts a number or stringified number. The legacy `network` field is still accepted as a
> deprecated alias…"*

Creating a workflow with `config.chainId` is rejected:

```json
{"code":"UNKNOWN_FIELD","path":"nodes[1].data.config.chainId",
 "actionType":"safe/get-nonce","message":"Unknown field \"chainId\" for action \"safe/get-nonce\"."}
```

`network` is required and `chainId` is unknown — the exact inverse of the documentation. Reproduced
on `safe/get-nonce`, `safe/get-owners`, `safe/get-threshold`, `safe/get-pending-transactions` and
`web3/read-contract`, so it is not plugin-specific.

The error is clear and fails closed, which is the good case. The cost is that the schema tips are
the first thing an agent reads when authoring a workflow programmatically — and following them
produces an invalid workflow every time.

**Suggested fix:** accept `chainId` as the alias the tips promise, or correct the tips to name
`network` as canonical. Either is a small change; the current state guarantees a failed first
attempt for anyone who trusts the documentation.

**Adjacent, same session:** `web3/read-contract` requires `abi` **and** `abiFunction`. Supplying
`functionName` (the natural guess, and the name viem/ethers use) passes create-time validation and
then fails at runtime with `Missing \`abiFunction\` in the step config`. Moving that check into the
same validator that already catches `UNKNOWN_FIELD` would turn a runtime failure into a create-time
one.

---

## DX-6 · One plugin page, two different chain lists, no machine-readable warning

**Severity:** medium — it silently rules out testnet development for a whole plugin.
**Date:** 2026-09-02

The Safe plugin page states both:

> *"Supported chains for on-chain reads: Ethereum, Base, Arbitrum, Optimism."*
> *"Pending transaction monitoring supports: … Sepolia, Base Sepolia."*

Both are accurate, and together they mean **the Safe plugin cannot be exercised end to end on any
testnet**: the queue read works on Sepolia, while `get-nonce`, `get-owners` and `get-threshold`
reject it with `expected: 1 | 10 | 8453 | 42161`.

For anything that reads a Safe's queue *and* validates it against on-chain state — which is the
normal shape for a multisig automation — a testnet rehearsal is impossible using the plugin alone.
The available workaround is to drop to `web3/read-contract` against the Safe's own `view` functions,
which works on every chain and is what we now do. That is fine, but it has to be discovered by
hitting the wall.

Nothing surfaces this before create time: `get_plugin safe` returns one flat `chains` array for the
whole plugin, with no per-action restriction, so an agent planning a workflow cannot see the
limitation until validation rejects it.

**Suggested fix:** carry the supported-chain set per action in the schema so it can be read
programmatically, and note on the plugin page that on-chain reads are mainnet-only. If the
restriction is incidental rather than deliberate, adding the four testnets would remove the need for
the workaround entirely.

---

## DX-7 · Plan gating is invisible until workflow-create, and it gates the two most composable actions

**Severity:** high — it is discoverable only by hitting it, after the workflow is designed.
**Date:** 2026-09-02

`POST /api/workflows/create` rejected a completed workflow with:

```json
{"error":"This workflow uses features that require a paid plan.","code":"upgrade_required",
 "violations":[
   {"featureId":"action.http-request","featureName":"HTTP Request action","requiredPlan":"pro","nodeIds":["hydrate-1"]},
   {"featureId":"action.code","featureName":"Code action","requiredPlan":"pro","nodeIds":["assemble-1"]}]}
```

The error itself is **excellent** — it names the feature, the plan, the action type and the exact
node ids. Nothing about the response is wrong. The problem is everything before it.

**Plan requirements are not discoverable in advance.** Checked today:

| Source | Discloses `requiredPlan`? |
|---|---|
| `GET /api/mcp/schemas` | **no** — the string `requiredPlan` does not appear; `code/run-code` exposes `requiresCredentials` but nothing about plan |
| `get_plugin` MCP tool | **no** |
| docs.keeperhub.com (106 pages, crawled to link closure) | **no match** for "paid plan", "requiredPlan", "upgrade_required" or "pro plan" |

So an agent authoring a workflow programmatically — which is precisely what the MCP server and the
schema tips exist to support — cannot know a node is unusable until it submits a finished graph and
is refused. The design work is already spent by then.

**And the two gated actions are the two general-purpose ones.** `code/run-code` and `HTTP Request`
are the escape hatches: the nodes you reach for when the 447 prebuilt actions don't cover your case.
For gavel they are not conveniences —

- `code/run-code` holds the **entire decision surface**: signature-blob assembly plus seven
  pre-broadcast refusal guards. There is no combination of prebuilt actions that sorts confirmations
  by ascending owner address and concatenates a signature blob.
- `HTTP Request` is only needed **because of DX-1**: the Safe plugin's projection omits five of
  `execTransaction`'s ten arguments, so the raw Transaction Service has to be read alongside it. A
  gap in a plugin is being patched by an action behind a paywall.

**Suggested fix, in order of preference:**

1. Add `requiredPlan` to the action schema so `GET /api/mcp/schemas` and `get_plugin` expose it.
   This is the whole fix for the discovery problem, and it is one field.
2. Document the gated set on the plugins overview page.
3. Consider whether a **hackathon or trial allowance** for `action.code` is warranted — an event
   inviting integrations against a live project is, by construction, inviting the cases the prebuilt
   actions do not cover.

**Status for us:** unresolved. It does not block the mechanism — assembly can run outside the
workflow and execute through the **Direct Execution API**, which is not plan-gated — but that moves
the decision off-platform, which is a weaker answer to "execution *through* KeeperHub" and a worse
demo. Asking the organiser in Discord before restructuring.

---

## Notes for filing

- Target repo: `github.com/KeeperHub/keeperhub`. Preflight the issue template's
  duplicate-search checkbox against open **and** closed issues before submitting, and do
  not tick a verification box that has not actually been performed — the maintainer checks
  claims against source.
- DX-1 is the strongest candidate: a concrete behavioural gap, a security-relevant
  consequence, and a fix that is a passthrough rather than a redesign.
- Carried over from the previous edition and **requiring re-verification against current
  `staging` before it may be filed**: `check-and-execute` cannot address a member of a
  tuple-returning read (observed in production 2026-08-08, 25+ days stale as of this
  writing).

---

## DX-8 · `analytics/runs` silently ages history out, and it is the audit trail

**Severity:** high — it makes an execution ledger unreproducible, with no signal that it happened.
**Date:** 2026-09-09

`GET /api/analytics/runs` is the only machine-readable record of what KeeperHub executed, and this
project treats it as exactly that: `scripts/audit.mjs` paginates it to `nextCursor` exhaustion and
renders the result as the audit trail.

On 2026-09-07 that call returned **150 runs** for this org. On 2026-09-09, paginated identically
with the same credential, it returned **2** — both from that morning. The 150 executions of
2026-09-06/07 were gone. Nothing in the response distinguishes "you have 2 runs" from "you have 2
runs left": there is no retention field, no truncation flag, no `total`, and the pagination
terminates normally.

The consequence is worse than a missing feature. A regenerate-in-place — the documented workflow
for this kind of artifact, and what our own file header instructed — **silently replaces a 150-row
audit trail with a 2-row one and exits 0.** We hit exactly that and recovered only because the file
was committed. `audit.mjs` now refuses to shrink the file without an explicit `--prune`.

A second-order effect worth naming: a run that fails has no `transactionHashes`, so it contributes
no row at all. The losing half of a deliberate race (`yhak2pfniragtz0x8we15`, `Error(GS026)`) is
invisible in the receipts even while it is still inside the retention window. The endpoint that
records what executed structurally cannot record what did not.

**Suggested fix:** state the retention period in the docs and return it in the response; add a
`total` or an explicit `truncated` flag so a client can tell exhaustion from expiry; and expose
failed runs with enough identity to be counted even without a transaction hash. If retention is
plan-dependent, say which plan buys what — this is the one endpoint whose whole value is that it
remembers.

## DX-9 · `matchesRegex` is documented, generated by the builder, and rejected by the validator

**Severity:** medium — a documented Condition operator cannot be used at all; the error message
points somewhere else.
**Date:** 2026-09-11 · execution `4y5c1zst9hoegqkybyhvj` · **filed as [#2407](https://github.com/KeeperHub/keeperhub/issues/2407)**

`docs/workflows/creating.md` lists `matchesRegex` among the Condition operators. Our address gate
used it: `{{@trigger-1:Webhook.safeAddress}} matchesRegex ^0x[0-9a-fA-F]{40}$`. The first canvas
run failed at that node with *"Cannot index "0x[...]". Reference step outputs with the
{{@nodeId:Label.field}} template format…"* — advice about template syntax, for an expression
whose template syntax was fine.

Reading `lib/workflow/nodes/condition/validator.ts` explains why no spelling works:

- `checkBracketExpressions` matches `(\w+)\s*\[` anywhere in the raw expression, **inside string
  literals included**, so any character class preceded by a word character (`0x[`, `a-f[`) is
  rejected as bare indexing.
- The builder compiles the operator to `new RegExp("…").test(String(…))`
  (`condition/expression.ts:120`), but `DANGEROUS_PATTERNS` contains `/\bnew\s+\w/` and
  `ALLOWED_METHODS` has no `test`. The compiled form is banned twice.

So the operator exists in the docs and the UI, and every expression it produces fails validation.
The tests in `tests/unit/condition-builder-utils.test.ts` cover generation and parsing, never
evaluation.

**Workaround:** `startsWith("0x") && .length === 42`, with the strict regex in the Code node.
**Suggested fix:** mask string literals before the bracket and dangerous-pattern checks, and either
allowlist `new RegExp(...)`/`.test` for this operator or evaluate `matchesRegex` natively instead of
compiling it to JS. Until then, remove it from the operator list — an operator that is documented
and unusable costs more than one that is absent.

## DX-10 · `workflows/create` stores `workflowType: read` regardless of nodes; only `PATCH` derives

**Severity:** medium — combined with #2227's freeze-at-listing, it is a trap with a misleading
warning in front of it.
**Date:** 2026-09-11 · workflow `7v0qwhcp5gcex58gjugyg` · **already tracked as [#2014](https://github.com/KeeperHub/keeperhub/issues/2014); dated production repro added as a [comment](https://github.com/KeeperHub/keeperhub/issues/2014#issuecomment-5635854571)**

`POST /api/workflows/create` with a graph containing a `web3/write-contract` node returned a row
with `workflowType: "read"`. `validate_workflow` then warned `write-action-on-read-workflow` —
"confirm this is intentional" — on a workflow nobody had classified. A no-op
`PATCH /api/workflows/{id}` with the same nodes flipped it to `write`, because the PATCH route
derives from node content (#2227) and the create route does not.

Why it matters: #2227 freezes `workflowType` at the listing PATCH. A workflow created and listed
without an intermediate save — the obvious agent flow, `create_workflow` → `list_workflow` — lists
as `read`, and the Marketplace call then routes to `handleReadWorkflow`: the server executes with
the **owner's** wallet and returns results, instead of returning calldata for the caller to sign.
For a workflow whose whole point is that the caller executes, that is the wrong contract, frozen.

**Suggested fix:** derive on create exactly as on PATCH, or have `validate_workflow` say *"stored
type was never derived — save once"* rather than asking the author to confirm a classification
they did not make.

## DX-11 · `failOnError: false` turns a reverted write into `success: true` at every level

**Severity:** high for observability — the one outcome an executor most needs to see is the one
that reports as success.
**Date:** 2026-09-11 · executions `819zav3gl3fkd89n7cb42` (won) and `j9g0a58oxem50jct5qpt7` (lost) · **filed as [#2408](https://github.com/KeeperHub/keeperhub/issues/2408)**

Two concurrent triggers of the same workflow against the same Safe nonce. One broadcast and moved
the money; the other's `execTransaction` reverted with `Error(GS026)`. The loser's `exec-1` node
log reads:

```
{"error": "Contract call failed: Error(GS026)", "success": true,
 "rejection": {"kind": "contract-custom", "name": "Error"}}
```

— `success: true` beside an `error`, node status `success`, execution status `success`,
`transactionHashes: []`. The workflow's own reporting cannot distinguish "drained the Safe" from
"reverted against it" without opening the node output and reading the error string. `failOnError:
false` is the right setting here — a Safe revert is a named outcome, not a dead run — but the flag
should suppress *abort*, not *truth*.

**Suggested fix:** keep `success` meaning the call succeeded; surface the swallowed error as a
distinct node status (`failed-continued`, or `status: success` + `error` populated at the
execution level), and count the run in `analytics/runs` with a `revertReason` even though it has
no hash. DX-8 already notes that a failed run leaves no row; this is the same gap from the other
side.
