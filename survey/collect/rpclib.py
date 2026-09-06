import json,urllib.request,time
RPC="https://mainnet.base.org"
UA={"content-type":"application/json","user-agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
def rpc(m,p,tries=4):
    for i in range(tries):
        try:
            req=urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers=UA)
            return json.loads(urllib.request.urlopen(req,timeout=90).read())
        except Exception as e:
            if i==tries-1: return {"error":{"message":"EXC "+repr(e)[:200]}}
            time.sleep(1.5*(i+1))
