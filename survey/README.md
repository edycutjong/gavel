# The wild-Safe survey

The number gavel's design rests on — **92.6% of transactions that look stalled are permanently
dead** — came from reading 1,299 real Base mainnet Safes. This directory is that measurement:
the scripts that made the calls, the raw responses they got back, and one command that re-derives
every published figure from them.

```bash
python3 survey/rederive.py
```

Offline. No network, no credentials, no dependencies, ~0.2 s. It checks 24 figures against what
`README.md` claims and exits non-zero on the first mismatch.

It exists because the rest of this repo does not ask to be trusted — the tests run against a
committed real Transaction Service response, the execution is verifiable by transaction hash,
`isOwner(executor)` is checkable by anyone. The survey was the one claim you had to take our word
for. Now it isn't.

---

## What was measured

**Measured 2026-09-02T09:55Z, at Base block 50,776,046.** A snapshot, not a live query — the
figures below describe the chain on that date and are deliberately frozen.

The Safe Transaction Service has no "list all Safes" endpoint, so the population was derived from
chain logs via the public RPC `https://mainnet.base.org`. Two samples were drawn, because they
answer different questions:

| Sample | Source event | Safes | What it tells you |
|---|---|---|---|
| **A — broad** | `ProxyCreation(address,address)` from SafeProxyFactory | 1,031 | All Safes, active or not |
| **B — active** | `ExecutionSuccess(bytes32,uint256)` | 298 | Safes that demonstrably execute |

They **overlap by 30** — a Safe can appear in both. The published population is the distinct
union: 1,031 + 298 − 30 = **1,299**, of which **1,298** returned HTTP 200. `rederive.py` asserts
this explicitly, because "1031 + 298 ≠ 1299" is the first thing a careful reader notices.

Sampling was windowed: 41 evenly-spaced windows across all of Base history (blocks 2,000,000 →
50,776,046), 400 blocks per window for Sample A and 300 for Sample B. `mainnet.base.org` returns
HTTP 413 on `eth_getLogs` above roughly 10k blocks or 6.5k logs, so the collectors chunk.

## What was found

| Naive detector: `!isExecuted && confirmations >= confirmationsRequired` | Count |
|---|---|
| Transactions matching | **366** |
| …**permanently dead** — nonce already consumed, can never execute | **339 (92.6%)** |
| …live | 27 (7.4%) |
| …live **and** at the Safe's current nonce | 6 |
| …and simulating `SUCCESS` under `eth_call` | **2** |

And the condition is rare: **5 of 1,298** readable Safes (0.39%), or **3 of 297** (1.01%) among
Safes that actually transact. Three of those five are threshold-1, so exactly **one** is a genuine
multi-party coordination failure.

Liveness was never decided from the queue's own copy of the threshold. Every candidate was checked
against **on-chain** `nonce()`, `getThreshold()` and `getOwners()`; every confirmation was
`ecrecover`'d against the *current* owner set; and every current-nonce candidate was put through a
read-only `execTransaction` `eth_call`. **No transaction was sent and no key was used.**

### Caveats, stated rather than buried

- **This is a sample, not a census.** At n=1,298 the 95% confidence interval on 0.39% is roughly
  **0.13%–0.90%**. Treat the claim as "about half a percent".
- **Single RPC endpoint.** All chain reads came from `mainnet.base.org`; results were not
  cross-checked against a second provider.
- **Three Safes had more than 100 pending transactions** and needed full cursor paging
  (`pagefull.py`); without it their queues would have been silently truncated.
- **Twelve Sample A addresses were rate-limited** on the first pass and re-queried with an API key
  (`retry.py`).
- One Safe never returned HTTP 200 at all — hence 1,298 readable rather than 1,299.

## Reproducing it

**From the committed data** (fast, offline, deterministic) — this is what CI runs:

```bash
python3 survey/rederive.py
```

**From the chain** (~40 minutes, public endpoints, re-measures against *today's* state so the
numbers will differ — that is the point of a snapshot):

```bash
cd survey/collect
python3 collect.py          # windowed eth_getLogs -> ProxyCreation  -> proxies_raw.json
python3 collect_active.py   # windowed eth_getLogs -> ExecutionSuccess -> active_raw.json
python3 sweep.py            # Transaction Service sweep, Sample A    -> sweep.json
python3 sweep_active.py     #                           Sample B     -> sweep_active.json
python3 retry.py            # re-query the rate-limited addresses
python3 pagefull.py         # full cursor paging for Safes with >100 pending
python3 onchain.py          # on-chain nonce() / getThreshold() / getOwners()
python3 analyze2.py sweep.json          # nonce-liveness classification -> *_final.json
python3 analyze2.py sweep_active.json
python3 verify_all.py       # getTransactionHash match + execTransaction eth_call
python3 recover.py          # ecrecover every confirmation vs current owners
```

A Safe Transaction Service API key at `~/.config/gavel/safe-api-key` raises the rate limit and is
needed for `retry.py`, `pagefull.py`, `verify_all.py`, `recover.py` and `simulate.py`. The
collectors and `onchain.py` need no credentials — they read the public RPC. **No script here holds
a secret**; every one reads its key from `~/.config/` at runtime, and none can write to the chain.

`rpclib.py` sends a browser `User-Agent`; `mainnet.base.org` returns 403 to bare `urllib`.

## Files

| Path | What it is |
|---|---|
| `rederive.py` | Re-derives and asserts all 24 published figures. Offline |
| `collect/rpclib.py` | Base RPC helper. Browser UA required |
| `collect/cs.py` | EIP-55 checksum, verified against `cast to-check-sum-address` |
| `collect/collect.py` · `collect_active.py` | Windowed `eth_getLogs` for each sample |
| `collect/sweep.py` · `sweep_active.py` | Transaction Service queue sweep |
| `collect/retry.py` · `pagefull.py` | Rate-limit retry; full paging for >100 pending |
| `collect/onchain.py` | On-chain `nonce()` / `getThreshold()` / `getOwners()` |
| `collect/analyze2.py` | Nonce-liveness classification → `*_final.json` |
| `collect/verify_all.py` | `getTransactionHash` match + read-only `execTransaction` simulation |
| `collect/recover.py` · `checksig.py` | `ecrecover` of every confirmation against current owners |
| `collect/simulate.py` · `probe.py` · `analyze.py` · `status.py` | Intermediate passes kept as they ran |
| `data/*.json` | Every raw and derived response, 1.3 MB, exactly as collected |

The scripts are committed **as they actually ran**, not cleaned up afterwards. They are terse and
they are not the product; rewriting them for presentation would mean the published numbers no
longer came from the committed code.
