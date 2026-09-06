import sys,json,datetime
f=sys.argv[1]
NOW=datetime.datetime.now(datetime.timezone.utc)
def age(s):
    d=datetime.datetime.fromisoformat(s.replace("Z","+00:00"))
    return (NOW-d).total_seconds()/86400
data=json.load(open(f))
tot=len(data); ok=[r for r in data if r["code"]==200]
pend=[r for r in ok if r.get("pending_count",0)>0]
stall_safes=[]; stalls=[]
for r in pend:
    sn=r.get("safe_nonce")
    for t in r["pending"]:
        req=t["req"]
        if req is None: continue
        if t["conf"]>=req:
            entry=dict(t); entry["safe"]=r["safe"]; entry["safe_nonce"]=sn
            entry["threshold"]=r.get("threshold"); entry["owners"]=r.get("owners")
            entry["version"]=r.get("version"); entry["created_block"]=r["block"]
            entry["age_days"]=round(age(t["sub"]),1)
            entry["executable_now"]= (sn is not None and t["nonce"]==sn)
            entry["queued_future"]= (sn is not None and t["nonce"]>sn)
            entry["stale_past_nonce"]= (sn is not None and t["nonce"]<sn)
            stalls.append(entry)
print(f"=== {f} ===")
print("sampled:",tot,"http200:",ok.__len__(),"non200:",[ (r['safe'],r['code']) for r in data if r['code']!=200][:5])
print("with >=1 pending unexecuted:",len(pend))
live=[s for s in stalls if not s["stale_past_nonce"]]
exe=[s for s in live if s["executable_now"]]
fut=[s for s in live if s["queued_future"]]
stale=[s for s in stalls if s["stale_past_nonce"]]
print("threshold-met unexecuted txs (all):",len(stalls))
print("  -> LIVE (nonce >= safe nonce):",len(live),"safes:",len(set(s['safe'] for s in live)))
print("  -> executable NOW (nonce == safe nonce):",len(exe),"safes:",len(set(s['safe'] for s in exe)))
print("  -> queued future nonce:",len(fut),"safes:",len(set(s['safe'] for s in fut)))
print("  -> dead (nonce already used):",len(stale),"safes:",len(set(s['safe'] for s in stale)))
live.sort(key=lambda s:-s["age_days"])
for s in live:
    print(f"  {s['safe']} nonce={s['nonce']}/{s['safe_nonce']} conf={s['conf']}/{s['req']} thr={s['threshold']} own={s['owners']} age={s['age_days']}d val={s['value']} to={s['to']} m={s['dd']} {'EXECUTABLE_NOW' if s['executable_now'] else 'queued'}")
json.dump({"live":live,"stale":stale},open(f.replace(".json","_stalls.json"),"w"))
