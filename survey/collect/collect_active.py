import sys,json,collections
sys.path.insert(0,'.')
from rpclib import rpc
# ExecutionSuccess(bytes32 txHash, uint256 payment)
TOPIC="0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e"
head=int(rpc("eth_blockNumber",[])["result"],16)
START=2_000_000; NWIN=40; SPAN=300
step=(head-START)//NWIN
safes=collections.Counter(); meta={}
for i in range(NWIN+1):
    fb=START+i*step; tb=min(fb+SPAN,head)
    r=rpc("eth_getLogs",[{"fromBlock":hex(fb),"toBlock":hex(tb),"topics":[TOPIC]}])
    if "result" not in r: print("ERR",fb,r.get("error"),flush=True); continue
    for lg in r["result"]:
        a=lg["address"].lower(); safes[a]+=1
        meta.setdefault(a,int(lg["blockNumber"],16))
    print(f"win {i} {fb}-{tb}: {len(r['result'])}",flush=True)
print("head",head,"unique active safes",len(safes))
json.dump({"head":head,"safes":[{"proxy":a,"block":meta[a],"execs":c} for a,c in safes.items()]},open("active_raw.json","w"))
