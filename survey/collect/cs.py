from Crypto.Hash import keccak
def checksum(a):
    a=a.lower().replace("0x","")
    h=keccak.new(digest_bits=256); h.update(a.encode())
    hh=h.hexdigest()
    return "0x"+"".join(c.upper() if c.isalpha() and int(hh[i],16)>=8 else c for i,c in enumerate(a))
