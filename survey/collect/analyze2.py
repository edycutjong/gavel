import sys,json,datetime
f=sys.argv[1]
NOW=datetime.datetime.now(datetime.timezone.utc)
def age(s):
    return (NOW-datetime.datetime.fromisoformat(s.replace("Z","+00:00"))).total_seconds()/86400
data=json.load(open(f))
oc=json.load(open(f.replace(".json","_onchain.json")))
ok=[r for r in data if r["code"]==200]
pend=[r for r in ok if r.get("pending_count",0)>0]
trunc=[r["safe"] for r in pend if r["pending_count"]>len(r["pending"])]
rows=[]
for r in pend:
    o=oc.get(r["safe"]) or {}
    sn=o.get("nonce"); th=o.get("threshold")
    for t in r["pending"]:
        t["nonce"]=int(t["nonce"])
        req=t["req"]
        req=int(req) if req is not None else None
        eff_req = th if th is not None else req
        if req is None and th is None: continue
        met = t["conf"] >= (req if req is not None else 10**9)
        met_now = t["conf"] >= eff_req
        rows.append({"safe":r["safe"],"nonce":t["nonce"],"safe_nonce":sn,"conf":t["conf"],
            "req":req,"onchain_threshold":th,"owners":o.get("owners"),"sub":t["sub"],
            "age":round(age(t["sub"]),1),"value":t["value"],"to":t["to"],"m":t["dd"],
            "hash":t["hash"],"met":met,"met_now":met_now,
            "cat":("dead" if (sn is not None and t["nonce"]<sn) else "now" if (sn is not None and t["nonce"]==sn) else "future")})
live=[x for x in rows if x["met_now"] and x["cat"] in ("now","future")]
now=[x for x in live if x["cat"]=="now"]
fut=[x for x in live if x["cat"]=="future"]
dead=[x for x in rows if x["met_now"] and x["cat"]=="dead"]
print(f"=== {f} ===")
print("sampled:",len(data),"| http200:",len(ok),"| with pending:",len(pend),"| truncated(>100 pending):",trunc)
print("threshold-met unexecuted rows:",len([x for x in rows if x['met_now']]))
print("  DEAD (nonce consumed):",len(dead),"in",len(set(x['safe'] for x in dead)),"safes")
print("  LIVE:",len(live),"in",len(set(x['safe'] for x in live)),"safes")
print("    EXECUTABLE NOW (nonce==safe nonce):",len(now),"in",len(set(x['safe'] for x in now)),"safes")
print("    QUEUED future nonce:",len(fut),"in",len(set(x['safe'] for x in fut)),"safes")
print()
for lbl,g in (("EXECUTABLE NOW",now),("QUEUED FUTURE",fut)):
    print("---",lbl,"---")
    for x in sorted(g,key=lambda y:-y["age"]):
        print(f"{x['safe']} n={x['nonce']}(safe={x['safe_nonce']}) conf={x['conf']}/{x['req']} thr_now={x['onchain_threshold']}/{x['owners']}own age={x['age']}d val={x['value']} to={x['to']} m={x['m']}")
    print()
json.dump({"now":now,"future":fut,"dead":dead,"all":rows},open(f.replace(".json","_final.json"),"w"))
