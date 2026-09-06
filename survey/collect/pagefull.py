import sys,json,os,urllib.request,time
sys.path.insert(0,'.')
from rpclib import rpc
K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
H={"user-agent":"Mozilla/5.0","accept":"application/json","Authorization":"Bearer "+K}
BASE="https://api.safe.global/tx-service/base/api/v2"
def get(u):
    for i in range(4):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=H),timeout=90).read())
        except Exception as e: time.sleep(2*(i+1))
    return None
for safe in sys.argv[1:]:
    url=f"{BASE}/safes/{safe}/multisig-transactions/?executed=false&limit=200"
    n=rpc("eth_call",[{"to":safe,"data":"0xaffed0e0"},"latest"]); sn=int(n["result"],16)
    th=rpc("eth_call",[{"to":safe,"data":"0xe75235b8"},"latest"]); thr=int(th["result"],16)
    tot=0; live=[]
    while url:
        d=get(url)
        if d is None: print("FAIL",safe); break
        tot+=len(d["results"])
        for t in d["results"]:
            nc=int(t["nonce"]); c=len(t.get("confirmations") or [])
            if nc>=sn and c>=thr:
                live.append((nc,c,t.get("confirmationsRequired"),t["submissionDate"],t["value"],t["to"],(t.get("dataDecoded") or {}).get("method"),t["safeTxHash"]))
        url=d["next"]
    print(f"{safe} safe_nonce={sn} thr={thr} pending_seen={tot} LIVE_threshold_met={len(live)}")
    for x in sorted(live,key=lambda y:y[0])[:15]: print("   ",x)
