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
