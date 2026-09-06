#!/usr/bin/env python3
"""
gavel — bench.py. Reduces committed execution rows to p50/p95. Python 3 stdlib
only: no dependencies, no network, no clock. Run it on a laptop that has never
seen `npm install` and it produces the same numbers as CI.

    python3 scripts/bench.py                      # newest receipts file
    python3 scripts/bench.py docs/receipts-8453.json

It is a REDUCER, not a harness. It cannot manufacture a measurement: with no
receipts file there is no output, and every number below is a function of rows
KeeperHub returned and `audit.mjs` wrote. That distinction is the reason this
file is allowed to exist at all — a synthetic latency harness invents its own
numbers, and this one cannot.

WHAT THE LATENCY IS, AND IS NOT. `durationMs` is KeeperHub's own execution
duration: the interval from accepting the request to the row completing, which
includes the wait for the transaction to be mined. It is a supporting metric,
never the headline. It measures a testnet under no load, and it says nothing
about how long a Safe transaction sat unexecuted before gavel found it — the
522-day figure is the number that matters, and it comes from the survey.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def percentile(values, p):
    """Nearest-rank percentile. No interpolation: with a couple of dozen samples
    an interpolated p95 invents a value that no execution actually took."""
    if not values:
        return None
    ordered = sorted(values)
    k = max(1, -(-p * len(ordered) // 100))  # ceil(p/100 * n)
    return ordered[k - 1]


def load(path):
    if not path.exists():
        sys.exit(f"bench.py: no receipts at {path}\n"
                 f"           run scripts/audit.mjs first — this file reduces, it does not collect.")
    return json.loads(path.read_text())


def main():
    if len(sys.argv) > 1:
        path = pathlib.Path(sys.argv[1])
        if not path.is_absolute():
            path = ROOT / path
    else:
        found = sorted((ROOT / "docs").glob("receipts-*.json"))
        if not found:
            sys.exit("bench.py: no docs/receipts-*.json — run scripts/audit.mjs first.")
        path = found[-1]

    doc = load(path)
    rows = doc.get("rows", [])
    eligible = doc.get("receiptsEligible")
    ok = [r for r in rows if r.get("status") == "success"]

    print(f"\n  {path.relative_to(ROOT)}")
    print(f"  chain {doc.get('chainId')} · {doc.get('chainName')} · receiptsEligible={eligible}")
    if eligible is False:
        print("  REHEARSAL — these rows are not evidence. audit.mjs refuses to put them in EVIDENCE.md,")
        print("  and the same rule applies to every number below.")
    print()

    if not rows:
        sys.exit("  no rows.\n")

    print(f"  executions        {len(rows)}")
    print(f"  successful        {len(ok)}"
          f"{'' if len(ok) == len(rows) else f'  ({len(rows) - len(ok)} not successful)'}")

    durations = [r["durationMs"] for r in ok if isinstance(r.get("durationMs"), (int, float))]
    if durations:
        print()
        print("  KeeperHub execution duration — accepted to row completed, mining included")
        print(f"    n               {len(durations)}")
        print(f"    min             {min(durations) / 1000:.2f} s")
        print(f"    p50             {percentile(durations, 50) / 1000:.2f} s")
        print(f"    p95             {percentile(durations, 95) / 1000:.2f} s")
        print(f"    max             {max(durations) / 1000:.2f} s")

    gas = [int(r["gasUsedWei"]) for r in ok
           if str(r.get("gasUsedWei", "")).lstrip("-").isdigit()]
    if gas:
        # gasUsedWei is the gas COST in wei, not a gas-unit count. Printing it
        # as "gasUsed" reads as ~113 trillion units of gas, which is nonsense
        # three orders of magnitude out. It is 0.000113 ETH.
        eth = lambda w: w / 1e18
        print()
        print("  gas cost per execTransaction (gasUsedWei, testnet ETH)")
        print(f"    n               {len(gas)}")
        print(f"    min             {eth(min(gas)):.6f} ETH")
        print(f"    p50             {eth(percentile(gas, 50)):.6f} ETH")
        print(f"    p95             {eth(percentile(gas, 95)):.6f} ETH")
        print(f"    max             {eth(max(gas)):.6f} ETH")
        spread = max(gas) - min(gas)
        print(f"    spread          {eth(spread):.6f} ETH  "
              f"({100 * spread / min(gas):.1f}% over the cheapest)")

    sources = {}
    for r in ok:
        sources[r.get("source", "unknown")] = sources.get(r.get("source", "unknown"), 0) + 1
    if sources:
        print()
        print("  by source        " + " · ".join(f"{k} {v}" for k, v in sorted(sources.items())))
    print()


if __name__ == "__main__":
    main()
