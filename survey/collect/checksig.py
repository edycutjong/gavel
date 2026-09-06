import sys,json,os,subprocess,urllib.request
sys.path.insert(0,'.')
from rpclib import rpc
K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
H={"user-agent":"Mozilla/5.0","accept":"application/json","Authorization":"Bearer "+K}
h=sys.argv[1]
d=json.loads(urllib.request.urlopen(urllib.request.Request(f"https://api.safe.global/tx-service/base/api/v1/multisig-transactions/{h}/",headers=H),timeout=60).read())
confs=sorted(d.get("confirmations") or [],key=lambda c:int(c["owner"],16))
sigs="0x"+"".join(c["signature"][2:] for c in confs)
# getTransactionHash
gt=subprocess.run(["cast","calldata","getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
 d["to"],str(d["value"]),d["data"] or "0x",str(d["operation"]),str(d["safeTxGas"]),str(d["baseGas"]),str(d["gasPrice"]),
 d["gasToken"],d["refundReceiver"],str(d["nonce"])],capture_output=True,text=True).stdout.strip()
r=rpc("eth_call",[{"to":d["safe"],"data":gt},"latest"])
th=r.get("result")
print("safe",d["safe"],"nonce",d["nonce"])
print("onchain txhash",th,"| service safeTxHash",d["safeTxHash"],"MATCH" if th==d["safeTxHash"] else "MISMATCH")
for sigfn in ["checkSignatures(bytes32,bytes,bytes)","checkSignatures(bytes32,bytes)"]:
    a=[th,"0x",sigs] if "bytes,bytes)" in sigfn else [th,sigs]
    cd=subprocess.run(["cast","calldata",sigfn]+a,capture_output=True,text=True).stdout.strip()
    if not cd: continue
    rr=rpc("eth_call",[{"to":d["safe"],"data":cd},"latest"])
    print(f"  {sigfn} ->", "OK (signatures valid)" if "result" in rr else json.dumps(rr.get("error"))[:150])
