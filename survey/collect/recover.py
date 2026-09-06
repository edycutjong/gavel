import sys,json,os,subprocess,urllib.request,time
sys.path.insert(0,'.')
from rpclib import rpc
from cs import checksum
from Crypto.Hash import keccak
K=open(os.path.expanduser("~/.config/gavel/safe-api-key")).read().strip()
H={"user-agent":"Mozilla/5.0","accept":"application/json","Authorization":"Bearer "+K}
def api(u):
    for i in range(4):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=H),timeout=90).read())
        except Exception: time.sleep(3*(i+1))
    return None
def cc(*a):
    return subprocess.run(["cast","calldata"]+list(a),capture_output=True,text=True).stdout.strip()
def ecrecover(h32,v,r,s):
    data="0x"+h32[2:]+hex(v)[2:].rjust(64,"0")+r.rjust(64,"0")+s.rjust(64,"0")
    res=rpc("eth_call",[{"to":"0x0000000000000000000000000000000000000001","data":data},"latest"])
    x=res.get("result")
    if not x or len(x)<66 or int(x,16)==0: return None
    return checksum("0x"+x[-40:])
def eth_sign_hash(h32):
    m=b"\x19Ethereum Signed Message:\n32"+bytes.fromhex(h32[2:])
    k=keccak.new(digest_bits=256); k.update(m); return "0x"+k.hexdigest()
def owners(safe):
    r=rpc("eth_call",[{"to":safe,"data":"0xa0e67e2b"},"latest"])
    d=r["result"][2:]; n=int(d[64:128],16)
    return [checksum("0x"+d[128+i*64:128+(i+1)*64][-40:]) for i in range(n)]

items=json.load(open("verified.json"))
seen={}
res=[]
for x in items:
    det=api(f"https://api.safe.global/tx-service/base/api/v1/multisig-transactions/{x['hash']}/")
    safe=det["safe"]
    ow=seen.get(safe) or seen.setdefault(safe,owners(safe))
    gt=cc("getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
        det["to"],str(det["value"]),det["data"] or "0x",str(det["operation"]),str(det["safeTxGas"]),
        str(det["baseGas"]),str(det["gasPrice"]),det["gasToken"],det["refundReceiver"],str(det["nonce"]))
    th=rpc("eth_call",[{"to":safe,"data":gt},"latest"]).get("result")
    good=[]; notes=[]
    for c in (det.get("confirmations") or []):
        sg=c["signature"][2:]
        if len(sg)!=130: notes.append("nonstandard-len"); continue
        r_,s_,v_=sg[0:64],sg[64:128],int(sg[128:130],16)
        if v_ in (27,28): rec=ecrecover(th,v_,r_,s_)
        elif v_ in (31,32): rec=ecrecover(eth_sign_hash(th),v_-4,r_,s_)
        elif v_==1: rec=checksum("0x"+r_[-40:]); notes.append("approvedHash")
        elif v_==0: rec=checksum("0x"+r_[-40:]); notes.append("contractSig")
        else: rec=None; notes.append("v=%d"%v_)
        if rec and rec in ow: good.append(rec)
        elif rec: notes.append("signer-not-owner:"+rec[:10])
    thr=int(rpc("eth_call",[{"to":safe,"data":"0xe75235b8"},"latest"])["result"],16)
    ok=len(set(good))>=thr
    res.append({**x,"valid_owner_sigs":len(set(good)),"threshold":thr,"owner_count":len(ow),"truly_authorised":ok,"notes":notes,"hash_ok":th==det["safeTxHash"]})
    print(f"{x['tag']} {safe} n={x['nonce']} age={x['age']}d valid_owner_sigs={len(set(good))}/{thr} AUTH={ok} exec={x.get('exec_sim')} notes={notes}",flush=True)
json.dump(res,open("recovered.json","w"))
