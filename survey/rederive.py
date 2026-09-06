#!/usr/bin/env python3
"""
Re-derives every number README.md publishes about the wild-Safe survey, from the
committed data in survey/data/, and asserts each one.

    python3 survey/rederive.py

Offline. No network, no credentials, no dependencies. Deterministic: the ages were
computed once at the measurement instant and stored, so this never drifts with the
clock. Exits 0 if every published figure matches, 1 on the first mismatch.

This exists because the 92.6% figure is the single most load-bearing claim in the
project, and a number a judge cannot recompute is a number they have to take on
trust. The rest of this repo does not ask for trust, so this one should not either.

To regenerate the underlying data from the chain instead of re-deriving from the
committed copy, see survey/README.md — that path takes ~40 minutes and hits public
endpoints only.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# Measurement context, fixed at collection time. Stated here so a reader does not
# have to infer that these figures are a snapshot rather than a live query.
MEASURED_AT = "2026-09-02T09:55Z"
CHAIN_HEAD = 50_776_046

failures = []


def check(label, actual, expected, note=""):
    ok = actual == expected
    mark = "ok  " if ok else "FAIL"
    suffix = f"   {note}" if note else ""
    print(f"  {mark}  {label:<44} {actual!s:>8}   (README: {expected}){suffix}")
    if not ok:
        failures.append(f"{label}: got {actual!r}, README claims {expected!r}")


def load(name):
    with open(os.path.join(DATA, name)) as fh:
        return json.load(fh)


def main():
    sweep_a = load("sweep.json")               # Sample A — broad (ProxyCreation)
    sweep_b = load("sweep_active.json")        # Sample B — active (ExecutionSuccess)
    final_a = load("sweep_final.json")
    final_b = load("sweep_active_final.json")

    print(f"\ngavel — wild-Safe survey, re-derived from committed data")
    print(f"measured {MEASURED_AT} at Base block {CHAIN_HEAD:,}\n")

    # --- Population -------------------------------------------------------
    # The two samples overlap: a Safe that emitted ProxyCreation may also have
    # emitted ExecutionSuccess. The published population is the DISTINCT union,
    # which is why 1031 + 298 does not equal 1299.
    addrs_a = {r["safe"].lower() for r in sweep_a}
    addrs_b = {r["safe"].lower() for r in sweep_b}
    readable_a = {r["safe"].lower() for r in sweep_a if r["code"] == 200}
    readable_b = {r["safe"].lower() for r in sweep_b if r["code"] == 200}

    distinct = addrs_a | addrs_b
    readable = readable_a | readable_b

    print("Population")
    check("Sample A sampled (broad)", len(addrs_a), 1031)
    check("Sample B sampled (active)", len(addrs_b), 298)
    check("overlap between samples", len(addrs_a & addrs_b), 30,
          "<- why A+B != the union")
    check("distinct Safes surveyed", len(distinct), 1299)
    check("distinct readable (HTTP 200)", len(readable), 1298,
          "<- 1 Safe never returned 200")

    # --- The naive detector ----------------------------------------------
    # `!isExecuted && confirmations >= confirmationsRequired`, evaluated against
    # the CURRENT on-chain threshold rather than the queue's stored copy.
    met = [x for x in final_a["all"] if x["met_now"]] + \
          [x for x in final_b["all"] if x["met_now"]]
    dead = final_a["dead"] + final_b["dead"]
    live = final_a["now"] + final_a["future"] + final_b["now"] + final_b["future"]
    at_nonce = final_a["now"] + final_b["now"]

    print("\nThe naive detector: !isExecuted && confirmations >= confirmationsRequired")
    check("transactions matching", len(met), 366)
    check("permanently dead (nonce consumed)", len(dead), 339)
    check("live", len(live), 27)
    check("live AND at the Safe's current nonce", len(at_nonce), 6)

    pct_dead = round(100 * len(dead) / len(met), 1)
    pct_live = round(100 * len(live) / len(met), 1)
    check("dead as % of matching", pct_dead, 92.6, "<- THE headline number")
    check("live as % of matching", pct_live, 7.4)

    # --- Simulation -------------------------------------------------------
    # Of the 6 at the current nonce, how many actually land under eth_call?
    # verified.json holds the 27 live rows carried through getTransactionHash
    # matching and a read-only execTransaction simulation.
    verified = load("verified.json")
    check("live rows carried to verification", len(verified), 27)

    # Every live row was put through three independent checks before any claim
    # was made about it: the Safe's own getTransactionHash must match the queue's
    # safeTxHash, every confirmation must ecrecover to a CURRENT owner, and the
    # whole execTransaction must be simulated read-only via eth_call.
    check("safeTxHash matched getTransactionHash", sum(1 for x in verified if x["hash_match"]), 27)
    check("all signatures ecrecover to current owners", sum(1 for x in verified if x["sig_valid"]), 27)
    check("simulating SUCCESS under eth_call",
          sum(1 for x in verified if x["exec_sim"] == "SUCCESS"), 2,
          "<- of 6 at the current nonce")

    # --- Rarity -----------------------------------------------------------
    safes_live = {x["safe"].lower() for x in live}
    print("\nHow rare is the condition?")
    check("distinct Safes holding a live stall", len(safes_live), 5)
    check("as % of readable Safes", round(100 * len(safes_live) / len(readable), 2), 0.39)
    safes_live_b = {x["safe"].lower()
                    for x in final_b["now"] + final_b["future"]}
    check("among Safes that actually transact", len(safes_live_b), 3)
    check("as % of Sample B readable", round(100 * len(safes_live_b) / len(readable_b), 2), 1.01)

    # --- The oldest stall -------------------------------------------------
    oldest = max(live, key=lambda x: x["age"])
    print("\nThe oldest live stall")
    check("age in days", oldest["age"], 522.6)
    check("Safe address", oldest["safe"],
          "0xE06A1ad7346Dfda7Ce9BCFba751DABFd754BAfAD")
    check("nonce", oldest["nonce"], 2)
    check("threshold", oldest["onchain_threshold"], 2)
    check("owners", oldest["owners"], 3, "<- a real 2-of-3")

    # --- Verdict ----------------------------------------------------------
    print()
    if failures:
        print(f"MISMATCH — {len(failures)} published figure(s) do not re-derive:\n")
        for f in failures:
            print(f"  - {f}")
        print("\nEither the data changed or README.md is wrong. Both are bugs.")
        return 1

    print("All published figures re-derive from the committed data.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
