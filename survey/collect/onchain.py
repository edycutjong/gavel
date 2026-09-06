import sys,json,threading,queue
sys.path.insert(0,'.')
from rpclib import rpc
f=sys.argv[1]
data=json.load(open(f))
targets=[r["safe"] for r in data if r.get("pending_count",0)>0]
print("fetching onchain nonce/threshold for",len(targets))
res={}; q=queue.Queue(); lock=threading.Lock()
for t in targets: q.put(t)
def w():
    while True:
        try: a=q.get_nowait()
        except queue.Empty: return
        n=rpc("eth_call",[{"to":a,"data":"0xaffed0e0"},"latest"])   # nonce()
        th=rpc("eth_call",[{"to":a,"data":"0xe75235b8"},"latest"])  # getThreshold()
        ow=rpc("eth_call",[{"to":a,"data":"0xa0e67e2b"},"latest"])  # getOwners()
        def dec(x):
            try: return int(x["result"],16)
            except Exception: return None
        nown=None
        try:
            d=ow["result"][2:]; nown=int(d[64:128],16)
        except Exception: pass
        with lock: res[a]={"nonce":dec(n),"threshold":dec(th),"owners":nown}
ts=[threading.Thread(target=w) for _ in range(6)]
[t.start() for t in ts]; [t.join() for t in ts]
json.dump(res,open(f.replace(".json","_onchain.json"),"w"))
print("ok",sum(1 for v in res.values() if v["nonce"] is not None),"of",len(res))
