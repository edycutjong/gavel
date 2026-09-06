import json, urllib.request

ADDRS = [
    ("executor", "0x5E2e5Fd3aD7fDC9B94482930db8b5F45E439bab7"),
    ("O1",       "0x019db835770D29FEd0E96071A59Ed812DFEC0c4a"),
    ("O2",       "0x20A5EdcDB3bf0587545De423cdd8Ba94c7D0D754"),
    ("O3",       "0x0644D5a2b729C3A4D0c5ee9337f29812522492Cf"),
    ("O4",       "0xb106572e189e79fF3B8f9D176470691313aBABb8"),
    ("O5",       "0x433B0dE89B1229B45e8F7ceCE6158ce2040dc8cb"),
    ("PAYEE",    "0x660295C3f3EB0D65cac00521DD393a5184E405B1"),
    ("ATTACKER", "0xA4dc630f7240e2D3bA2cc594401c6d11CF8F65f5"),
]
CHAINS = {
    "BASE SEPOLIA (84532) - rehearsal": ("https://base-sepolia-rpc.publicnode.com",
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    "BASE MAINNET (8453) - judged":     ("https://mainnet.base.org",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
}
# required ETH per role: (sepolia, mainnet). None = deliberately unfunded
REQ = {"executor": (0.0001, 0.020), "O1": (0.0001, 0.006), "PAYEE": (0.0001, 0.010),
       "O2": (0,0), "O3": (0,0), "O4": (0,0), "O5": (0,0), "ATTACKER": (0,0)}

def rpc(url, method, params):
    req = urllib.request.Request(url, method="POST",
        data=json.dumps({"jsonrpc":"2.0","method":method,"params":params,"id":1}).encode(),
        headers={"Content-Type":"application/json","User-Agent":"Mozilla/5.0 gavel-status"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("result")

for i,(label,(url,usdc)) in enumerate(CHAINS.items()):
    idx = 0 if "SEPOLIA" in label else 1
    print(f"\n{'='*74}\n {label}\n{'='*74}")
    print(f"{'ROLE':<10} {'ETH held':>14} {'ETH needed':>12} {'STATUS':<12} {'USDC':>10}")
    for name, a in ADDRS:
        try:
            wei = int(rpc(url,"eth_getBalance",[a,"latest"]) or "0x0",16)
            data = "0x70a08231" + a[2:].rjust(64,"0").lower()
            bal = int(rpc(url,"eth_call",[{"to":usdc,"data":data},"latest"]) or "0x0",16)
        except Exception as e:
            print(f"{name:<10} rpc error {e}"); continue
        eth = wei/1e18; need = REQ[name][idx]
        if need == 0:
            st = "n/a (never)" if name=="ATTACKER" else "n/a"
        elif eth >= need: st = "DONE"
        else: st = "NEEDED"
        print(f"{name:<10} {eth:>14.6f} {need if need else '-':>12} {st:<12} {bal/1e6:>10.2f}")
