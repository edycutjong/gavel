import sys,json,collections
sys.path.insert(0,'.')
from rpclib import rpc
TOPIC="0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235"
head=int(rpc("eth_blockNumber",[])["result"],16)
# spread windows across Base history. Base genesis 2023-06; use 2,000,000 -> head
START=2_000_000
NWIN=40
SPAN=400
step=(head-START)//NWIN
rows=[]; facs=collections.Counter(); errs=[]
for i in range(NWIN+1):
    fb=START+i*step
    tb=min(fb+SPAN,head)
    r=rpc("eth_getLogs",[{"fromBlock":hex(fb),"toBlock":hex(tb),"topics":[TOPIC]}])
    if "result" not in r:
        errs.append((fb,r.get("error"))); continue
    for lg in r["result"]:
        if len(lg["topics"])>=2: proxy="0x"+lg["topics"][1][-40:]
        else: proxy="0x"+lg["data"][2:66][-40:]
        facs[lg["address"].lower()]+=1
        rows.append({"proxy":proxy,"factory":lg["address"].lower(),"block":int(lg["blockNumber"],16)})
    print(f"win {i} blocks {fb}-{tb}: {len(r['result'])}", flush=True)
print("head",head,"total",len(rows),"unique",len(set(x['proxy'] for x in rows)))
print("factories:",facs.most_common(10))
print("errors:",errs)
json.dump({"head":head,"rows":rows},open("proxies_raw.json","w"))
