<div align="center">

  <img src="docs/assets/icon-animated.svg" alt="gavel Icon" width="144">

  <h1>gavel 👨‍⚖️</h1>

  <p><em>Executes threshold-met Safe transactions from a wallet that owns nothing.</em></p>

  <img src="docs/assets/readme-hero-animated.svg"
       alt="gavel — executes Safe transactions that reached their signature threshold but were never executed. A threshold-met Safe transaction waits amber; the gavel falls, and it turns mint: executed."
       width="100%">

  <br/>

  [![Live](https://img.shields.io/badge/🚀_Live-Site-06b6d4?style=for-the-badge)](https://gavel.edycu.dev/)
  [![Pitch Deck](https://img.shields.io/badge/📊_Pitch-Deck-f59e0b?style=for-the-badge)](https://gavel.edycu.dev/deck.html)
  [![Built for The Agent Economy](https://img.shields.io/badge/DoraHacks-Agent_Economy-8b5cf6?style=for-the-badge)](https://dorahacks.io/hackathon/agent-economy)

  <br/>

  ![tests](https://img.shields.io/badge/tests-87%20passing%20in%20~0.08s-2ea44f?style=flat)
  ![coverage](https://img.shields.io/badge/assemble.mjs-100%25%20line%20%2F%20branch-2ea44f?style=flat)
  ![deps](https://img.shields.io/badge/decision%20surface-zero%20deps%2C%20zero%20I%2FO-blue?style=flat)
  ![node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat)
  ![keeperhub](https://img.shields.io/badge/KeeperHub-Safe%20plugin%20%2B%20Direct%20Execution-6c4cf1?style=flat)
  ![safe](https://img.shields.io/badge/Safe-Transaction%20Service-12ff80?style=flat)
  [![License](https://img.shields.io/badge/License-MIT-yellow?style=flat)](https://opensource.org/licenses/MIT)
  [![CI](https://github.com/edycutjong/gavel/actions/workflows/ci.yml/badge.svg)](https://github.com/edycutjong/gavel/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/release/edycutjong/gavel?sort=semver&style=flat)](https://github.com/edycutjong/gavel/releases/latest)

</div>

---

## ⚖️ The finding this project is built on

A Safe multisig splits one act into two that are not the same thing. **Signing** is free, off-chain,
in the Safe Transaction Service. **Executing** is an on-chain call that costs gas, can be made by
**anyone**, and is nobody's job. So fully-authorised transactions rot.

The obvious next move is to scan for them. We did — read-only, over **1,299 distinct Base mainnet
Safes** sampled across 41 evenly-spaced windows covering all of Base history (blocks 2,000,000 →
50,776,046). The result killed our own pitch and replaced it with a better one:

| Naive detector: `!isExecuted && confirmations >= confirmationsRequired` | Count |
|---|---|
| Transactions matching | **366** |
| …**permanently dead** — nonce already consumed by a different tx, can never execute | **339 (92.6%)** |
| …live | 27 (7.4%) |
| …live **and** at the Safe's current nonce | 6 |
| …and simulating `SUCCESS` under `eth_call` | **2** |

> **A detector built on the obvious definition is ~93% false positives.**

And the condition itself is **rare, not epidemic**: 5 of 1,298 readable Safes (**0.39%**), or 3 of
297 (**1.01%**) among Safes that actually transact. Three of those five are threshold-1, so exactly
**one** is a genuine multi-party coordination failure. We do not claim thousands of stuck
transactions; the data we collected ourselves does not support it.

**So the guards are not defensive polish around the product. The guards *are* the product.** Anyone
can concatenate signatures. Knowing which 7.4% are real — and then which of those would actually
land — is the hard part, and it is measurable.

**Every number in that table is reproducible from this repo.** The scripts that made the calls, the
raw responses they returned, and a re-derivation that asserts all 24 published figures are committed
at [`survey/`](survey/) — and CI runs it, so the prose cannot drift away from the measurement:

```bash
python3 survey/rederive.py     # offline, no credentials, ~0.2s
```

Method in brief: Safe addresses derived from `ProxyCreation` and `ExecutionSuccess` logs on
`mainnet.base.org`; queues pulled from the Safe Transaction Service; liveness decided against
**on-chain** `nonce()` / `getThreshold()` / `getOwners()`, every confirmation `ecrecover`'d against
the *current* owner set, and every current-nonce candidate put through a read-only `execTransaction`
`eth_call`. No transaction was sent and no key was used. At n=1,298 the 95% CI on 0.39% is roughly
**0.13%–0.90%** — treat the claim as "about half a percent", and note this is a sample, not a census.

---

## 🔨 What gavel does — one sentence, one flow

> When a Safe transaction has collected enough owner signatures but nobody has paid the gas to
> execute it, gavel reassembles those signatures into the blob `checkSignatures` expects and calls
> `execTransaction` from a KeeperHub wallet that owns nothing on that Safe.

The onboarding ask is one line: *give me your Safe address.* No private key, no approval, no owner
slot, no capital, no contract to deploy. Nothing gavel can do that the owners had not already signed
for.

The decision surface is one pure file — [`src/assemble.mjs`](src/assemble.mjs), 429 lines, **zero
dependencies, zero I/O**: no fetch, no clock, no randomness, no hashing. It takes one Safe's
off-chain queue plus three live on-chain reads (`nonce()`, `getThreshold()`, `getOwners()`) and
returns either the ten `execTransaction` arguments or a **named refusal**. `fetch` *is* available in
the KeeperHub sandbox; not using it is deliberate, because a pure function can be tested offline
against real captured bytes and an impure one cannot.

---

## 🏗️ Architecture

<div align="center">
  <img src="docs/assets/architecture.png" alt="gavel architecture — the Safe Transaction Service queue and three live on-chain reads enter KeeperHub's Safe plugin; src/assemble.mjs decides purely and returns either ten execTransaction arguments or one of nine named refusals; Direct Execution broadcasts from a wallet that owns none of the Safe; KeeperHub's own execution rows are the audit ledger." width="100%">
</div>

Four surfaces carry one transaction, and only one of them is ours. The queue and the
signatures come from the Safe Transaction Service; the liveness reads and the broadcast happen
inside KeeperHub; the chain and the receipt belong to Base and Etherscan. What gavel adds is
the middle box — a pure function that turns a queue plus three on-chain reads into either ten
`execTransaction` arguments or a refusal with a name.

---

## 🚦 The nine named outcomes, and the three guards

Every non-execution has a machine-readable reason. Seven are decided **pre-broadcast** by the pure
function; two are read **post-broadcast** from KeeperHub's own execution row.

| # | Outcome | Invariant | When |
|---|---|---|---|
| 1 | `not-next-nonce` | I2 · I11 | No queued tx at the live on-chain nonce — **or two different proposals share it**, which is how "replace transaction" works, and choosing between them is not gavel's call |
| 2 | `below-threshold` | I1 | Fewer distinct owner signatures than `max(queue threshold, on-chain threshold)` |
| 3 | `eip1271-unsupported` | I7 | A `CONTRACT_SIGNATURE` / `APPROVED_HASH` confirmation, or one that is not 65 well-formed bytes |
| 4 | `refund-requested` | I4 | `gasPrice != 0`, or non-zero `gasToken` / `refundReceiver` — see below, this is a drain vector aimed at the executor |
| 5 | `delegatecall-refused` | I5 | `operation == 1`. We will not `delegatecall` someone's treasury on a schedule |
| 6 | `threshold-drift` | I1 | The threshold was raised on-chain *after* signing; the queue still believes the old number is enough |
| 7 | `owner-removed` | I6 | A confirmation from an address that is no longer an owner — a signature collected legitimately last week, from an owner removed yesterday |
| 8 | `raced-gs026` | post-broadcast | Someone else consumed the nonce first. An expected outcome, not a crash |
| 9 | `inner-call-failed` | post-broadcast | `execTransaction` succeeded; the inner call reverted (`GS013`) |

Plus **three guards that are deliberately not among the nine**, because a guard whose correct
behaviour is "never fires" must still not fall through to execution:

| Guard | Why it exists |
|---|---|
| `not-on-roster` | I3, re-checked inside the pure function and not only at the workflow's roster node, because a public Marketplace listing is a caller-open door |
| `incomplete-payload` | The Safe plugin's projection omits five of `execTransaction`'s ten arguments. When they have not been hydrated we **cannot** evaluate the refund guard — so we refuse rather than assume zero |
| `malformed-payload` | Input that is not well-formed at all — a `safeAddress` that is not 20 bytes, a non-integer nonce, an empty owner array. Returned from eight call sites in [`src/assemble.mjs`](src/assemble.mjs). Five of its eight call sites guard the **queued transaction** (`tx.to`, `tx.gasPrice`, `tx.value`, `tx.safeTxGas`, `tx.baseGas` — all Transaction Service fields); three guard the caller's own inputs. This row said "guards a caller, not a queued transaction" until 2026-09-09, and that wrong reading was the stated reason for its `n/a` above |

### Which of them have actually *happened*

A refusal branch covered by a unit test is a claim about a pure function. A refusal branch with a
row in `docs/outcomes-<chain>.jsonl` is a claim about this software, running against a real Safe on
a real chain. Those are different evidence and this table does not let them look the same.

Every terminal state of a drain — refused, guarded, failed precondition, dry, executed — is written
by [`scripts/outcome-log.mjs`](scripts/outcome-log.mjs). The table is generated, never hand-kept:
`node scripts/outcomes.mjs --markdown`.

| # | outcome | decided by | named in `test/` | observed live | rows |
|---|---|---|---|---|---|
| 1 | `not-next-nonce` | assemble | ✅ | ✅ | 5 |
| 2 | `below-threshold` | assemble | ✅ | ✅ | 3 |
| 3 | `eip1271-unsupported` | assemble | ✅ | ✅ | 2 |
| 4 | `refund-requested` | assemble | ✅ | ✅ | 2 |
| 5 | `delegatecall-refused` | assemble | ✅ | ✅ | 2 |
| 6 | `threshold-drift` | assemble | ✅ | **n/a** | 0 |
| 7 | `owner-removed` | assemble | ✅ | **n/a** | 0 |
| 8 | `raced-gs026` | chain | ✅ | ✅ | 1 |
| 9 | `inner-call-failed` | chain | ✅ | ✅ | 3 |
| — | `not-on-roster` | assemble | ✅ | ✅ | 8 |
| — | `incomplete-payload` | assemble | ✅ | **n/a** | 0 |
| — | `malformed-payload` | assemble | ✅ | **n/a** | 0 |

**All 8 reachable outcomes have been observed against a real Safe on a real chain.** The last one,
`eip1271-unsupported`, needed no signer contract in the end: a Safe owner can pre-approve a hash
**on-chain** with `approveHash(bytes32)` instead of producing an ECDSA signature, and
`checkSignatures` then accepts a 65-byte word whose `v` is **1** — `r` is the owner address, `s` is
zero, and nothing is verified at all. That is the same shape the guard refuses, and it costs one
cheap transaction from an EOA rather than a deployment. `seed.mjs govern --action approve-hash`
does it.

**Four are marked `n/a`, and that is a finding rather than a gap.** They cannot be produced through
the production data source at all:

| outcome | why it cannot happen | measured |
|---|---|---|
| `threshold-drift` | the Safe Transaction Service reports `confirmationsRequired` as the **live** threshold, never a proposal-time snapshot, so "the queue still believes the old number is enough" is a state it will not serve | `BENCH_GOV`, threshold raised 2→3 after signing; the service reported 3 immediately |
| `owner-removed` | the service **prunes** confirmations from addresses that are no longer owners — the stale signature never reaches a reader | `BENCH_ROTATE`, `O2` signed, `O2` removed; the service then returned the transaction with `O2` absent |
| `incomplete-payload` | canvas-only: the Safe plugin projection omits five of the ten arguments. `drain.mjs` hydrates from the tx service and always has all ten | — |
| `malformed-payload` | the Service validates and normalises the fields it serves, so it does not emit a malformed one. **Not** because it only guards a caller — five of its eight call sites guard `tx.*` fields that arrive *from* the Service. A different queue source could reach it | — |

This corrects something this README used to claim. Outcome 7 was described as *"a signature
collected legitimately last week, from an owner removed yesterday — naive tooling broadcasts it."*
Naive tooling reading this service would never see that signature. **The guards stay** — the
decision surface is pure and source-agnostic, and a queue that does not normalise (the plugin
projection, a self-hosted service, a replayed fixture) can still present both shapes. They are
defence in depth, and saying so is more useful than four green ticks.

---

## 🏆 KeeperHub Integration

KeeperHub is not a deployment target bolted on at the end — it is the runtime. gavel has no server,
no scheduler and no wallet of its own; every read, every gate and the broadcast itself happen inside
KeeperHub. Four API surfaces and the Safe plugin carry the whole flow:

Every surface below carries a **liveness claim** with a date. "Live" means it ran against a real
Safe on a real chain and the executionId is on record. The canvas rows are dated 2026-09-11,
because that is the day the Pro trial made them reachable — earlier than that this table said
"authored, not in the production path" for all of them, and it was right to.

| Surface | Liveness | Where | What it does |
|---|---|---|---|
| **`POST /api/execute/contract-call`** | ✅ **live — all 150 executions** | [`scripts/drain.mjs:210`](scripts/drain.mjs) | Direct Execution. Always `simulate: true` as a preflight, then the real call. **There is no idempotency key** — this README claimed one until 2026-09-09 and the API exposes none. Two identical calls both broadcast, which is exactly what the deliberate race did; one came back `Error(GS026)`. Only the Safe nonce prevents a double-spend |
| **`GET /api/analytics/runs`** | ✅ **live — 150 rows** | [`scripts/audit.mjs:54`](scripts/audit.mjs) | KeeperHub's own execution rows are the audit ledger: `id`, `source`, `status`, `transactionHashes`, `startedAt`, `completedAt`, `durationMs`, `gasUsedWei`, `error`. Those we render and never compute. `verified` / `receiptStatus` / `blockNumber` / `gasUsed` are **ours**, added only under `--verify` from `getTransactionReceipt` against the RPC — this README credited them to KeeperHub until 2026-09-09 |
| **MCP server** | ✅ live, design-time | spikes | `get_plugin`, `get_spending_limits`, `list_projects`, `list_integrations`, `GET /api/mcp/schemas`. Every platform claim here was checked against a live MCP call |
| **`POST /api/workflows/create`** · **`PATCH /api/workflows/{id}`** | ✅ **live — 2026-09-11** | [`scripts/sync.mjs`](scripts/sync.mjs) `--push` | Emits and creates the `gavel-drain` graph — 11 nodes, 10 edges, committed at [`workflows/`](workflows/). Rejected with `upgrade_required` on the free plan until 09-11 (**issue #2279**, still a real DX gap); created as `7v0qwhcp5gcex58gjugyg` the day the trial unlocked it. `create` stores `workflowType: read` regardless of nodes and only `PATCH` derives it — so the first save is what makes a write workflow `write` |
| **Canvas execution** — `POST /api/workflows/{id}/execute` | ✅ **live — 7 runs, 2026-09-11** | [`docs/outcomes-11155111.jsonl`](docs/outcomes-11155111.jsonl) rows with `stage: canvas` | The graph decided inside KeeperHub 7 times: **2 executions** (`hq4av5dbacb1i5z9bxfs0` → [`0x188addfb…`](https://sepolia.etherscan.io/tx/0x188addfb861b79c7d300966680fe3edc02140e58515425bfef358b4329b95a5c), `819zav3gl3fkd89n7cb42` → [`0x1377a121…`](https://sepolia.etherscan.io/tx/0x1377a12125f9bc1b463bbd276fa2baa8edeeadc31a8f9580ff22187b933ce9f0)), **2 named refusals** (`not-next-nonce`, `refund-requested`), **1 deliberate GS026 race loss** (`j9g0a58oxem50jct5qpt7`), 2 generator-bug runs kept in the fix log. Same `assemble.mjs`, same decisions `drain.mjs` makes |
| **Marketplace listing** — `POST /api/mcp/workflows/gavel-drain/call` | ✅ **live — listed 2026-09-11 12:36 UTC** | [`workflows/gavel-drain-11155111-listed.json`](workflows/gavel-drain-11155111-listed.json) | Slug `gavel-drain`, $0.05 USDC/call, x402 v2 on Base. The row is `write`, so a paid call returns `execTransaction` calldata the caller signs from **their own** wallet — a judge can drain a roster Safe themselves. **Zero external paid calls so far**; say so before anyone asks |
| **Safe plugin** — `safe/get-pending-transactions` | ✅ **live on the canvas — 2026-09-11** | `workflows/*.json` node `queue-1` | The queue read runs through the Safe plugin on every canvas run. `-threshold`, `-owners`, `-nonce` are in the Base graph only: the plugin's on-chain reads reject Sepolia (**DX-6**), so the Sepolia graph takes them with `web3/read-contract` against the Safe's own view functions. `drain.mjs` still reads `api.safe.global` and the RPC directly |
| **`web3/read-contract`** ×3 · **`web3/write-contract`** | ✅ **live on the canvas — 2026-09-11** | `workflows/*.json` nodes `threshold-1`, `owners-1`, `nonce-1`, `exec-1` | `exec-1` is why the graph exists — all **7** Safe plugin actions are reads, so there is no Safe-plugin write action to execute with. It sent both canvas executions and swallowed the race loss: with `failOnError: false` a reverted write comes back `{"error":"Contract call failed: Error(GS026)","success":true}` and the execution finalises as `success` with no hash |

**So be precise about what "through KeeperHub" means here.** Value moved through KeeperHub 150
times via the Direct Execution API (09-06/07) and the ledger proving it is KeeperHub's own — that
part was always real. As of 2026-09-11 the *decision* also runs inside KeeperHub: the canvas
workflow read the queue through the Safe plugin, read the chain, ran `assemble.mjs` in a Code
node and sent `execTransaction` from a write node — 2 executions, 2 refusals, 1 race loss. The
canvas track record is one day old and `drain.mjs` has the longer one. Both import the same
`assemble.mjs`, so the decision is identical either way; we are not going to blur which path
produced which number.

The graph is generated, never hand-drawn: `sync.mjs` injects [`src/assemble.mjs`](src/assemble.mjs)
**verbatim** into the Code node, so the function the tests run offline and the function the canvas
runs on-chain cannot drift apart. That is the whole reason the decision surface is pure.

Eleven reproducible findings came out of building against it, dated as they were hit and filed
upstream — see [`DX-REPORT.md`](DX-REPORT.md); three of them (DX-9/10/11) came out of the first
day on the canvas. The sharpest is still DX-8: **`analytics/runs` ages history out with no signal**, so the endpoint this project treats as the audit trail returned 150
runs on 09-07 and 2 on 09-09. `audit.mjs` now refuses to shrink `docs/receipts-*.json` without
`--prune`, because a regenerate-in-place would have destroyed a ledger the API can no longer
reproduce. The transaction hashes on disk remain verifiable on the explorer regardless.

---
## 🕳️ The gap that would have silently disarmed a security guard

`safe/get-pending-transactions` documents its output as *"safeTxHash, to, value, data, operation,
nonce, confirmations, confirmationsRequired, dataDecoded, submissionDate"*.

`execTransaction` takes **ten** arguments. The projection supplies four of the payload fields and
omits **`safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`** — verified live against
the running plugin, not read off a docs page.

Two of those five are not cosmetic. `execTransaction` pays a refund from the Safe to
`refundReceiver` and ***calls*** `gasToken`. A hostile pair is a drain vector aimed precisely at
whoever executes — which is us. The natural workaround is to default the missing fields to zero, and
**that silently disarms the single most dangerous guard in the design**: every payload then looks
refund-free, including the ones that are not.

gavel refuses with `incomplete-payload` instead, and reads the raw Transaction Service alongside the
plugin to hydrate the five fields. Filed upstream as **DX-1** in
[`DX-REPORT.md`](DX-REPORT.md) — the strongest of eleven findings, with a fix that is a passthrough
rather than a redesign.

### And a normalisation we deliberately did *not* write

Every Safe integration guide tells you to normalise the signature `v` byte. gavel does not, and
[`src/assemble.mjs`](src/assemble.mjs) says why in a comment written **before** we had the data: the
Transaction Service stores each signature exactly as the signing client produced it, and Safe's own
clients already write `v = 27/28` (EIP-712) or `v = 31/32` (`eth_sign`) — precisely what
`checkSignatures` expects. Pass-through is correct; *adding* normalisation would have been the bug.

That was a prediction. Then we staged a real threshold-met payout and read the bytes back:

```
confirmations[0]  0x019db835…0c4a  ETH_SIGN  65 bytes  v = 0x1f (31)
confirmations[1]  0x20A5EdcD…D754  ETH_SIGN  65 bytes  v = 0x20 (32)
```

Predicted, then measured. The cryptographic surface stays at six lines.

---

## ✅ What is actually proven, as of 2026-09-09

**150 end-to-end executions through KeeperHub**, on Ethereum Sepolia (11155111) — the
**rehearsal** chain. [`docs/receipts-11155111.json`](docs/receipts-11155111.json) holds all 150,
150 of 150 `success`, every one via the Direct Execution API, in the window
2026-09-06T16:01Z → 2026-09-07T10:11Z. The execution detailed below is an **earlier** one and is
deliberately not among those 150 — it is the first that ran end to end, and it is the one whose
every field was checked by hand:

| | |
|---|---|
| tx | [`0xf0b3b611…a4cc68`](https://sepolia.etherscan.io/tx/0xf0b3b61144dc272ce39508056d600f28bbb7b92de1b2e30c4dc4da856ea4cc68) |
| executionId | `qy3vfai4lux3yokk7ilea` · `receiptStatus: success` · block 11,618,878 |
| gasUsed | **144,637** |
| value moved | **10.00 USDC** out of a Safe, to the payee |
| `isOwner(executor)` on that Safe | **false** — checked on chain |
| Safe nonce | 0 → 1 |

A threshold-met, deliberately unexecuted payout was drained by an address that owns nothing on that
Safe. Three gates ran first and all passed: `assemble.mjs` → a local read-only `eth_call` →
KeeperHub's own `simulate: true` preflight.

Also standing up:

- **12 Safes deployed** on Ethereum Sepolia from one manifest, CREATE2-deterministic, eight of them funded —
  thresholds 1-of-2 through 3-of-5, **nine of them on the opt-in roster**. That was five until
  2026-09-09: the four `BENCH_*` Safes each exist to demonstrate one named refusal, and none of
  them could, because `not-on-roster` is the FIRST check in `assemble.mjs` and a `roster:false`
  Safe refuses on the roster gate before reaching its own scenario. `HERO_B` stays off the roster
  deliberately — it carries `assertNotOnRoster` and is the witness that the guard fires.
- **The volume loop recycles, and you should know that when reading any execution count.** Every
  Safe swept is one we deployed, and the payouts they queue are ours — this is *mechanism* volume,
  never summed with third-party volume. Value used to flow O1 -> Safe -> PAYEE exactly once, and
  since the Sepolia faucet grants 20 USDC the cast simply ran dry. `scripts/seed.mjs recycle` now
  returns drained USDC from PAYEE to O1 so [`scripts/sweep.mjs`](scripts/sweep.mjs) can run
  `fund -> stage -> drain` again. The same USDC therefore moves many times. Execution counts are
  counts of *executions*, not of distinct dollars, and the refusal invariant is what the volume is
  there to test.
- **87 tests, ~0.08 s**, including [`test/live-fixture.test.mjs`](test/live-fixture.test.mjs), which
  runs the untouched `assemble.mjs` over a **committed real Safe Transaction Service response**. Unit
  fixtures prove we are self-consistent; that file proves we match reality, and they are deliberately
  two different files.
- A test that asserts **the executor is never an owner of any Safe in the cast**, because that
  non-membership *is* the product claim.
- A test that asserts **no `receiptsEligible: false` chain can contribute a row to `EVIDENCE.md`** —
  the testnet/evidence separation enforced in code, not in a habit.

### What is *not* done — stated plainly

- **No mainnet execution exists yet.** `EVIDENCE.md` is absent by design rather than empty-by-accident:
  `scripts/audit.mjs` refuses to write a row from a chain marked `receiptsEligible: false`, and the
  only executions so far are on the rehearsal chain. The rehearsal log lives separately at
  [`docs/rehearsal-11155111.md`](docs/rehearsal-11155111.md) and is labelled **NOT EVIDENCE** at the top.
- **The canvas workflow only became possible late.** `POST /api/workflows/create` rejects the
  graph on the free plan with `upgrade_required`: both `code/run-code` (which holds the entire
  decision surface) and `HTTP Request` (needed only *because* of the DX-1 gap above) require
  **pro**, and nothing — schemas, `get_plugin`, or 106 crawled doc pages — discloses that before
  create time. That is **DX-7**, filed as issue #2279 and maintainer-confirmed 09-04; it still
  stands as a developer-experience problem even though a 14-day trial activated 2026-09-11 no
  longer blocks us. The workflow has therefore run on the canvas only since **2026-09-11**, across
  **7** executions, whereas [`scripts/drain.mjs`](scripts/drain.mjs) has the 150-run track record on
  the Direct Execution API. Both import the same `assemble.mjs`, so the decision is identical.
- **Two more generator bugs were only findable by running.** The first canvas run died at the
  address gate because `matchesRegex` — listed in the docs — cannot pass the Condition validator
  in any form; the second died in the Code node because templates are substituted as JSON values
  and `sync.mjs` had quoted two of them. Both fixed in `sync.mjs` and both filed in
  [`DX-REPORT.md`](DX-REPORT.md).
- **The Marketplace listing has zero external paid calls.** It went live 2026-09-11 12:36 UTC at
  $0.05; nobody outside this team has paid to call it. Not published to the KeeperHub Hub; no demo
  of the listing in the video.

---

## 🧾 Why the on-chain sender looks wrong (and why the claim still holds)

Open that transaction and the top-level `From` is `0x809D8252…0444` — a relayer we do not recognise —
and `To` is a contract we do not recognise. Our `execTransaction` is an **internal call**. This will
be the first thing a judge notices, so here it is before you wonder.

KeeperHub writes on supported networks are **gas-sponsored** by default, and the docs are explicit
that *"a sponsored transaction was not sent by your wallet, so it does not appear there."* But
`eth_getCode` on our executor returns:

```
0xef0100955d84139e7621bc571b117d8eb5d28a4a222c6f
  ^^^^^^ EIP-7702 delegation designator
        └─ delegate target 0x955d8413…2c6f
```

The executor is a **delegated EOA, not a bypassed one**. Under EIP-7702 the delegate code runs *in
the EOA's own context*, so **`msg.sender` at the Safe is still the executor's address** — which is
exactly why the executor's nonce incremented (0 → 1) while its ETH balance did not change.

So the claim — *executed by an address that owns none of them* — is true, and `isOwner(executor)`
returns `false` on chain for anyone who wants to check it themselves. What is *not* true is that you
can verify it by opening the executor's address page and counting. **Verify by transaction hash.**

There is currently **no supported way to opt out of sponsorship**, which matters for any keeper whose
entire evidence is "watch this one address". Filed as **DX-4**.

---

## 🕰️ The 522-day stall (somebody else's data)

The survey turned up material we could not have staged.

**`0xE06A1ad7346Dfda7Ce9BCFba751DABFd754BAfAD`, nonce 2 — 522.6 days.** A real **2-of-3** Safe on
Base. Proposed 2025-03-28T20:24Z, fully signed to threshold **35 minutes later** by two addresses
that ecrecover to its *current* owners, and sitting at the Safe's current on-chain nonce ever since.
The execution slot has been open for a year and five months, and any address on Earth could have
called `execTransaction` on it the entire time.

And the honest part: **simulated today it reverts with `GS013`.** The signatures pass; the inner
batch fails, because the Safe's ETH balance is now 0. The authorisation is real and the opportunity
decayed — which is the sharpest possible argument *for* gavel, not against it.

That is also why [`scripts/drain.mjs`](scripts/drain.mjs) will not broadcast without a passing
read-only simulation: another Safe in the sample, `0xF262c998…6DA8`, has **nine fully-signed
transactions that have never executed**. Two of them sat at the live nonce and were therefore
simulated; both reverted. The revert carried **no reason string** — `survey/data/verified.json`
records `REVERT:execution reverted`, and the other seven were never simulated at all — so "a guard
rejects these" is the likeliest reading and not a measured one. Until 2026-09-09 this paragraph
named `InvalidSignatures()`, which appears nowhere in the committed data. A tool that promises to clear those is advertising drains that can never land.

---

## 🏃 Run it yourself

**One command checks everything.** Zero credentials, no network, under a second:

```bash
git clone https://github.com/edycutjong/gavel && cd gavel
npm install
npm run verify
```

It runs every gate CI runs, in the same order, and prints PASS/FAIL per gate:

| Gate | What it proves |
|---|---|
| Decision surface is pure | `src/assemble.mjs` contains no `import`, `eval`, `fetch`, `Date.now`, `Math.random` or `process.env` — invariant I10 |
| JS test suite | 87 tests, `node --test` |
| Published figures re-derive | all 24 README figures, re-derived from 1.25 MB of committed raw responses |
| Solidity tests | `forge test` — skipped **loudly** if foundry is absent, never passed quietly |

An optional gate that cannot run reports `SKIP`, not `PASS`. A gate you can't run must never look green.

If you would rather run the pieces yourself:

```bash
npm test                       # 87 tests, ~0.08 s, no network, no keys
```

That suite includes `test/live-fixture.test.mjs`, which runs `src/assemble.mjs` over a committed real
Transaction Service response — so "the tests pass" is not a claim about fixtures we invented.

The rehearsal token has its own suite, and it also needs nothing installed — no `forge-std`, no
`lib/`, no submodules, because the four cheatcodes it uses are declared inline:

```bash
forge test                     # 22 tests, one of them a fuzz run
forge coverage                 # 100% lines, statements, branches and funcs
```

CI enforces that 100%, on all four metrics, rather than reporting it.

The remaining commands touch real chains and need real credentials, kept in `~/.config/` and never in
this tree (`~/.config/gavel/seed.txt` for the cast mnemonic, `~/.config/gavel/safe-api-key`,
`~/.config/keeperhub/env`):

```bash
# read-only: balances, deploy state, roster. Spends nothing.
node scripts/seed.mjs status  --chain 11155111

# compute the 12 CREATE2 Safe addresses without deploying anything.
node scripts/seed.mjs predict --chain 11155111

# deploy / fund the cast, then propose+sign a payout to threshold and STOP.
node scripts/seed.mjs deploy  --chain 11155111
node scripts/seed.mjs fund    --chain 11155111
node scripts/seed.mjs stage   --chain 11155111 --safe HERO_A

# run the pure function against a LIVE queue + live on-chain state.
node scripts/verify-assemble.mjs --chain 11155111 --safe HERO_A

# three gates, then stop. Dry by default — --execute is the only way to broadcast.
node scripts/drain.mjs --chain 11155111 --address 0xB8709787228046C4612D969A153942e1693e6169

# regenerate the workflow JSON with assemble.mjs injected verbatim into the Code node.
node scripts/sync.mjs --chain 8453 --safe-integration <id>

# render KeeperHub's own execution rows into a log; refuses ineligible chains.
node scripts/audit.mjs --chain 11155111
```

`drain.mjs` without `--execute` stops after the three gates, always. A named refusal exits `3` (assemble-decided) or `1` (`raced-gs026` and `inner-call-failed`, caught after the pure function); exit `0` means the gates passed —
refusing correctly is a success, not an error.

---

## 🗺️ Repo map

| Path | What it is |
|---|---|
| [`src/assemble.mjs`](src/assemble.mjs) | The entire decision surface. Pure, zero deps, zero I/O. Injected verbatim into the workflow's Code node by `sync.mjs`, so canvas and repo cannot drift |
| [`src/manifest.json`](src/manifest.json) | The 12-Safe cast + per-chain constants. `receiptsEligible` is load-bearing |
| [`src/roster.json`](src/roster.json) | The opt-in list. Derived from the manifest by `seed.mjs roster`, never hand-kept |
| [`scripts/seed.mjs`](scripts/seed.mjs) | `status` · `predict` · `deploy` · `fund` · `stage` · `recycle` · `roster` · `govern`. Stages the conditions. `stage --hostile <variant>` builds a queue shaped to force ONE named refusal; `govern` is the only subcommand that spends gas on something other than a payout — `approve-hash` produces the unverified `v=1` word that outcome 3 refuses, and the two config actions are kept for the record even though the service normalises both outcomes away |
| [`scripts/drain.mjs`](scripts/drain.mjs) | assemble → local `eth_call` → KeeperHub `simulate` → Direct Execution |
| [`scripts/verify-assemble.mjs`](scripts/verify-assemble.mjs) | The pure function against a live queue; `--write-fixture` turns today's response into a regression test |
| [`scripts/sync.mjs`](scripts/sync.mjs) | Emits the workflow JSON per chain (three of the four Safe plugin reads swap to `web3/read-contract` on testnets; `queue-1` stays `safe/get-pending-transactions` on both, because queue monitoring does support Sepolia — see DX-6) |
| [`scripts/audit.mjs`](scripts/audit.mjs) | Renders KeeperHub execution rows. Renders; never computes |
| [`scripts/outcome-log.mjs`](scripts/outcome-log.mjs) | One durable row per terminal state of a drain. KeeperHub's ledger can only ever show successes — outcomes 1-7 are decided before anything is sent — so refusals needed a record of their own |
| [`scripts/outcomes.mjs`](scripts/outcomes.mjs) | Generates the coverage table above from that log plus `test/`. `--markdown` for the pasteable form |
| [`scripts/bench.py`](scripts/bench.py) | Reduces those rows to p50/p95 duration and gas cost. Python 3 stdlib, no network — a reducer, never a harness: with no receipts there is no output |
| [`contracts/`](contracts/) | `MockUSDC.sol`, the testnet stand-in, and [`contracts/test/`](contracts/test/) — 22 tests at 100% coverage on every metric, dependency-free |
| [`test/`](test/) | 87 tests: unit fixtures, the live-response regression file, manifest/roster invariants, and the coverage-gap suite ([`COVERAGE.md`](test/COVERAGE.md)) |
| [`survey/`](survey/) | The 1,299-Safe measurement: collectors, 1.25 MB of raw responses, and `rederive.py`, which asserts all 24 published figures offline |
| [`DX-REPORT.md`](DX-REPORT.md) | Eleven reproducible KeeperHub findings, dated as they were hit |
| [`workflows/`](workflows/) | Generated `gavel-drain` graph, 11 nodes (1 trigger + 10 actions), 10 edges |
| [`docs/rehearsal-11155111.md`](docs/rehearsal-11155111.md) | Rehearsal log. Labelled NOT EVIDENCE |
| [`docs/outcomes-11155111.jsonl`](docs/outcomes-11155111.jsonl) | Every decision gavel made on that chain, refusals included. Append-only JSON Lines |

---

## 🧭 What we refused to build, and why

| Not built | Reason |
|---|---|
| Any risk score or AI opinion on the payload | The owners already decided. An opinion turns gavel into a gatekeeper, which is the opposite of the product |
| EIP-1271 contract signatures | ~60 lines of offset arithmetic for a minority case. Refused by name: `eip1271-unsupported` — and the refusal **is** demonstrated, without a signer contract: an owner pre-approving a hash on-chain produces the same unverified `v = 1` word, which `seed.mjs govern --action approve-hash` does in one transaction |
| A dashboard | The demo runs on three surfaces we did not build: app.safe.global, the KeeperHub canvas, the block explorer |
| A database, or a copy of KeeperHub's execution rows | Its rows carry `status`, `durationMs` and `gasUsedWei`, and `--verify` adds the chain's own `receiptStatus`, `blockNumber` and `gasUsed`. A copy of that is a worse copy. **`docs/outcomes-*.jsonl` is not that copy** — it records what gavel *decided*, which is a strictly larger set: a refusal never reaches the API, and a failed run carries no transaction hash, so neither can appear in execution rows |
| A custom contract, staking, or a bond | gavel's claim is that the executor needs no trust. A bond invents the trust relationship the design exists to delete |
| Private-mempool routing | It **does** exist on KeeperHub write actions. We turn it down: private-mempool writes are not gas-sponsored, and execution outputs carry no public/private route field, so the route could never be evidenced on a receipt |
| A Safe-plugin *write* action | It does not exist. All **7** Safe plugin actions are reads. Saying so is more useful than implying otherwise |

---

## 🔻 What we got wrong

Corrections we made to our own published claims, dated, each one checkable against the commit
named. They are here rather than only in `git log` because a retraction nobody can read is not a
retraction.

| Date | We said | It was actually | Fixed in |
|---|---|---|---|
| **2026-09-11** | This README, the landing page, the deck and the frozen BUIDL answers all said *the workflow does not exist on the canvas* | **True until 2026-09-11 08:06 UTC, false after.** A Pro trial unlocked `workflows/create`; the graph ran 7 times on the canvas the same day and was listed on the Marketplace. The frozen DoraHacks Q2 answer still carries the old claim and cannot be edited — read it as dated 09-09 | [`fb6ea60`](../../commit/fb6ea60), [`f086cfc`](../../commit/f086cfc), [`a5414a5`](../../commit/a5414a5) |
| **2026-09-09** | Outcome 7 described *"a signature collected legitimately last week, from an owner removed yesterday — naive tooling broadcasts it"* | **Naive tooling would never see that signature.** The Safe Transaction Service prunes confirmations from addresses that are no longer owners, and reports `confirmationsRequired` as the live threshold — so `owner-removed` and `threshold-drift` cannot be produced through it at all. Measured on `BENCH_ROTATE` and `BENCH_GOV`, not inferred. Both guards stay as defence in depth; the coverage table now says `n/a` | [`c0fef30`](../../commit/c0fef30) |
| **2026-09-09** | `audit.mjs` said *"Do not hand-edit — regenerate"* | **Regenerating destroyed the ledger.** KeeperHub's `analytics/runs` aged 150 runs down to 2 between 09-07 and 09-09 with no retention signal, so a regenerate-in-place replaced a 150-row audit trail with a 1-row one and **exited 0**. It came back only because the file was committed. A shrinking rewrite is now a refusal. Filed as DX-8 | [`8d55bcb`](../../commit/8d55bcb) |
| **2026-09-09** | The landing page repeated two of the three invented claims above | `site/index.html` carried the same non-existent `Idempotency-Key`, and credited KeeperHub with `verified` / `receiptStatus` / `blockNumber` / `gasUsed` in the same words the README did. Fixing the README did not fix the page a judge actually opens first, and the second sweep is the only reason it was caught | [`site/index.html`](site/index.html) |
| **2026-09-09** | Stale counts in five separate places, found five separate times | The README said **50 executions** (data: 150) and **80 tests** (suite: 87); rostering four Safes took the opt-in list from five to nine while the README still said five; and the **landing page and deck were worse** — `site/index.html` claimed **24 executions, median 14.3 s** against a real 150 and 11.6 s, plus `80 tests` in three more places; `survey/README.md` still asserted the **22 figures** this very table retracts; and `DEMO.md` said **64 tests**, untouched since 09-02 and sitting on the reproduce path the README sends judges down. One cause throughout: the data is regenerated and the prose is not | [`0c3ccfc`](../../commit/0c3ccfc), [`88bb3d2`](../../commit/88bb3d2), [`site`](site/index.html) |
| **2026-09-07** | The README said `rederive.py` asserts **22** published figures | It asserts **24**. A stale count, carried across the README, the project description and a published write-up | [`408ff1b`](../../commit/408ff1b) — and the number is no longer hardcoded in `npm run verify`, so it cannot drift again |
| **2026-09-06** | Our OG image led with a Safe *"stalled 9d 04h"* | **An invented duration on an invented Safe.** The assets were generated on Aug 26 against a pitch that no longer held, and their hero figures were composites. Every number in them is now measured | [`154694d`](../../commit/154694d) |
| **2026-09-06** | Eleven invariants, stated as holding | **Three of eleven did not hold as written**, and in the generated workflow none of them were load-bearing. An adversarial review also found a critical injection: `sync.mjs` spliced a webhook-supplied address raw into a JS source string, so a caller could close the literal and hoist their own `assemble()` over the real one, bypassing all eleven guards at once. Every case was a working exploit before it was a test | [`ac621ab`](../../commit/ac621ab) |
| **2026-09-06** | The test badge said **50 tests** | The suite had **64**. Corrected — then found stale a second time and corrected again | [`414176c`](../../commit/414176c), [`3e795e9`](../../commit/3e795e9) |
| **2026-09-06** | The demo video's closing card listed **three** honest gaps while its own narration said *"two honest gaps, both on screen"* | The count disagreed with the voiceover, and the third bullet **denied the existence of the video a judge was watching at that moment**. It was also submission status, not an engineering limitation | [`be6383f`](../../commit/be6383f) |

### And the pitch itself

The largest correction is the product's premise. We set out to build a keeper that clears stuck
Safe transactions, on the assumption that the hard part was cryptographic — reassembling collected
signatures into the blob `checkSignatures` expects. That part is about 40 lines.

Then we ran the obvious detector against 1,299 Base mainnet Safes, read-only, **before** writing
the pitch. It matched 366 transactions and **339 of them can never execute**. The detector we were
about to ship is ~93% false positives, and the condition is *rare* — 5 of 1,298 readable Safes,
**0.39%** — not the epidemic a launch post would have implied.

So the refusal logic is not defensive polish around the product. It is the product. We would rather
say that here than have you find it.

---

## 📄 License

MIT — see [`LICENSE`](LICENSE).
