import sys,json,os,subprocess,urllib.request
sys.path.insert(0,'.')
from rpclib import rpc
K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
H={"user-agent":"Mozilla/5.0","accept":"application/json","Authorization":"Bearer "+K}
def api(u):
    return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=H),timeout=60).read())
def sim(safeTxHash):
    d=api(f"https://api.safe.global/tx-service/base/api/v1/multisig-transactions/{safeTxHash}/")
    confs=sorted(d.get("confirmations") or [],key=lambda c:int(c["owner"],16))
    sigs="0x"+"".join(c["signature"][2:] for c in confs)
    args=["cast","calldata","execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
        d["to"],str(d["value"]),d["data"] or "0x",str(d["operation"]),str(d["safeTxGas"]),str(d["baseGas"]),
        str(d["gasPrice"]),d["gasToken"],d["refundReceiver"],sigs]
    cd=subprocess.run(args,capture_output=True,text=True)
    if cd.returncode!=0: return d,None,"calldata-err: "+cd.stderr.strip()[:200]
    calldata=cd.stdout.strip()
    r=rpc("eth_call",[{"to":d["safe"],"from":"0x1111111111111111111111111111111111111111","data":calldata,"gas":hex(8_000_000)},"latest"])
    if "result" in r:
        return d,("SUCCESS" if int(r["result"],16)==1 else "RETURNED_FALSE"),r["result"]
    return d,"REVERT",json.dumps(r.get("error"))[:300]

for h in sys.argv[1:]:
    d,verdict,extra=sim(h)
    print(f"{d['safe']} nonce={d['nonce']} confs={len(d.get('confirmations') or [])} -> {verdict}")
    print("   ",str(extra)[:250])
