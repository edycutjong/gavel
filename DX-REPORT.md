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

## DX-3 · Nothing distinguishes a managed Turnkey wallet from an imported key at a glance

**Severity:** low — but it silently invalidates a security claim.
**Date:** 2026-09-02

`list_integrations` returns `isManaged: false` for a web3 integration created by importing
a key, and the platform metadata elsewhere describes wallets as
`"provider": "Turnkey", "features": ["secure-enclave", "non-custodial", "hosted"]`. Both
are accurate; together they are easy to conflate. A project that states "signed inside a
Turnkey secure enclave" while pointing at an imported key has made a false security claim
without doing anything obviously wrong.

**Suggested fix:** surface the distinction in the integration label or add an explicit
`custodyModel: "turnkey-managed" | "imported-key"` field.

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
