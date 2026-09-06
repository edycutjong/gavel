import sys,json,time,urllib.request,urllib.error,threading,queue
sys.path.insert(0,'.')
from cs import checksum
BASE="https://api.safe.global/tx-service/base/api/v2"
UA={"user-agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36","accept":"application/json"}
import os
_K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
UA["Authorization"]="Bearer "+_K
lock=threading.Lock()
def get(url,tries=5):
    for i in range(tries):
        try:
            r=urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=60)
            return r.getcode(),json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429,502,503,504):
                time.sleep(2*(i+1)); continue
            return e.code,None
        except Exception:
            time.sleep(1.5*(i+1))
    return -1,None

rows=json.load(open("active_raw.json"))["safes"]
addrs=[]
seen=set()
for r in rows:
    if r["proxy"] in seen: continue
    seen.add(r["proxy"]); addrs.append((checksum(r["proxy"]),r["block"],r.get("execs")))
print("to query",len(addrs))

out=[]; q=queue.Queue()
for a in addrs: q.put(a)
def worker():
    while True:
        try: _r=q.get_nowait(); a,blk,fac=_r
        except queue.Empty: return
        code,d=get(f"{BASE}/safes/{a}/multisig-transactions/?executed=false&limit=100")
        rec={"safe":a,"block":blk,"execs":fac,"code":code}
        if code==200 and d is not None:
            rec["pending_count"]=d["count"]
            rec["pending"]=[{"nonce":t["nonce"],"isExecuted":t["isExecuted"],"conf":len(t.get("confirmations") or []),
                             "req":t.get("confirmationsRequired"),"sub":t["submissionDate"],"to":t["to"],
                             "value":t["value"],"data":(t.get("data") or "")[:10],
                             "dd":(t.get("dataDecoded") or {}).get("method") if t.get("dataDecoded") else None,
                             "hash":t["safeTxHash"]} for t in d["results"]]
            if d["count"]>0:
                c2,s=get(f"{BASE}/safes/{a}/")
                if c2==200 and s: rec["safe_nonce"]=s.get("nonce"); rec["threshold"]=s.get("threshold"); rec["owners"]=len(s.get("owners") or []); rec["version"]=s.get("version")
                else: rec["safe_info_code"]=c2
        with lock:
            out.append(rec)
            if len(out)%100==0: print("done",len(out),flush=True)
ts=[threading.Thread(target=worker) for _ in range(6)]
[t.start() for t in ts]; [t.join() for t in ts]
json.dump(out,open("sweep_active.json","w"))
from collections import Counter
print("codes",Counter(r["code"] for r in out))
print("with pending>0", sum(1 for r in out if r.get("pending_count",0)>0))
