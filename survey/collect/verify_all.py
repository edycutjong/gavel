import sys,json,os,subprocess,urllib.request,time
sys.path.insert(0,'.')
from rpclib import rpc
K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
H={"user-agent":"Mozilla/5.0","accept":"application/json","Authorization":"Bearer "+K}
def api(u):
    for i in range(4):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=H),timeout=90).read())
        except Exception: time.sleep(3*(i+1))
    return None
def cc(*a):
    r=subprocess.run(["cast","calldata"]+list(a),capture_output=True,text=True)
    return r.stdout.strip()
out=[]
for f,tag in (("sweep_final.json","A-broad"),("sweep_active_final.json","B-active")):
    d=json.load(open(f))
    for cat in ("now","future"):
        for x in d[cat]:
            det=api(f"https://api.safe.global/tx-service/base/api/v1/multisig-transactions/{x['hash']}/")
            if det is None: out.append({**x,"tag":tag,"cat":cat,"sig":"API_FAIL"}); continue
            confs=sorted(det.get("confirmations") or [],key=lambda c:int(c["owner"],16))
            sigs="0x"+"".join(c["signature"][2:] for c in confs)
            gt=cc("getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
                det["to"],str(det["value"]),det["data"] or "0x",str(det["operation"]),str(det["safeTxGas"]),
                str(det["baseGas"]),str(det["gasPrice"]),det["gasToken"],det["refundReceiver"],str(det["nonce"]))
            r=rpc("eth_call",[{"to":det["safe"],"data":gt},"latest"])
            th=r.get("result")
            cs=cc("checkSignatures(bytes32,bytes,bytes)",th,"0x",sigs)
            rr=rpc("eth_call",[{"to":det["safe"],"data":cs},"latest"])
            sigok = "result" in rr
            if not sigok:
                cs2=cc("checkSignatures(bytes32,bytes)",th,sigs)
                rr2=rpc("eth_call",[{"to":det["safe"],"data":cs2},"latest"])
                sigok = "result" in rr2
            exec_v=None
            if cat=="now":
                ed=cc("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
                    det["to"],str(det["value"]),det["data"] or "0x",str(det["operation"]),str(det["safeTxGas"]),
                    str(det["baseGas"]),str(det["gasPrice"]),det["gasToken"],det["refundReceiver"],sigs)
                er=rpc("eth_call",[{"to":det["safe"],"from":"0x1111111111111111111111111111111111111111","data":ed,"gas":hex(8000000)},"latest"])
                exec_v = "SUCCESS" if ("result" in er and int(er["result"],16)==1) else ("REVERT:"+str((er.get("error") or {}).get("message"))[:40])
            out.append({**x,"tag":tag,"cat":cat,"hash_match":th==det["safeTxHash"],"sig_valid":sigok,"exec_sim":exec_v,
                        "proposer":det.get("proposer"),"origin":(det.get("origin") or "")[:120],"operation":det["operation"]})
            print(f"{tag} {x['safe']} n={x['nonce']} {cat} age={x['age']}d sig_valid={sigok} exec={exec_v}",flush=True)
json.dump(out,open("verified.json","w"))
