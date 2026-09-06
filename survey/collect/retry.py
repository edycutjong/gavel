import sys,json,os,urllib.request,urllib.error,time
sys.path.insert(0,'.')
K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
H={"user-agent":"Mozilla/5.0","accept":"application/json","Authorization":"Bearer "+K}
BASE="https://api.safe.global/tx-service/base/api/v2"
def get(u):
    for i in range(5):
        try:
            r=urllib.request.urlopen(urllib.request.Request(u,headers=H),timeout=90); return r.getcode(),json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429,502,503,504): time.sleep(2*(i+1)); continue
            return e.code,None
        except Exception: time.sleep(2*(i+1))
    return -1,None
data=json.load(open("sweep.json"))
bad=[r for r in data if r["code"]!=200]
print("retrying",len(bad))
for r in bad:
    c,d=get(f"{BASE}/safes/{r['safe']}/multisig-transactions/?executed=false&limit=100")
    r["code"]=c
    if c==200 and d:
        r["pending_count"]=d["count"]
        r["pending"]=[{"nonce":t["nonce"],"isExecuted":t["isExecuted"],"conf":len(t.get("confirmations") or []),
            "req":t.get("confirmationsRequired"),"sub":t["submissionDate"],"to":t["to"],"value":t["value"],
            "data":(t.get("data") or "")[:10],"dd":(t.get("dataDecoded") or {}).get("method") if t.get("dataDecoded") else None,
            "hash":t["safeTxHash"]} for t in d["results"]]
json.dump(data,open("sweep.json","w"))
from collections import Counter
print("codes now",Counter(r["code"] for r in data))
print("with pending>0",sum(1 for r in data if r.get("pending_count",0)>0))
