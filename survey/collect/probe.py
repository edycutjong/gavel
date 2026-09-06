import json,urllib.request
RPC="https://mainnet.base.org"
def rpc(m,p):
    req=urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers={"content-type":"application/json"})
    return json.loads(urllib.request.urlopen(req,timeout=60).read())
TOPIC="0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235"
FACTORIES=["0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67","0xa6b71e26c5e0845f74c812102ca7114b6a896ab2","0xc22834581ebc8527d974f8a1c97e1bea4ef910bc"]
bn=int(rpc("eth_blockNumber",[])["result"],16)
print("head",bn)
for f in FACTORIES:
    r=rpc("eth_getLogs",[{"fromBlock":hex(bn-2000),"toBlock":hex(bn),"address":f,"topics":[TOPIC]}])
    print(f, "logs" in str(r) or "", len(r.get("result",[])) if "result" in r else r.get("error"))
