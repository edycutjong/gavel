# DEMO — the real run, with its receipt

One command, one real transaction, every number below re-read from the chain rather than
copied from a log. Nothing here is a replay, a fixture, or a dry run.

**Chain:** Ethereum Sepolia (11155111) — the rehearsal chain.
**No mainnet execution exists yet**, so `EVIDENCE.md` is deliberately absent: `scripts/audit.mjs`
refuses to write a row from a chain marked `receiptsEligible: false`. That refusal is a test
(`test/manifest.test.mjs`), not a habit.

---

## The receipt

```
executionId    qy3vfai4lux3yokk7ilea        (KeeperHub Direct Execution API)
transaction    0xf0b3b61144dc272ce39508056d600f28bbb7b92de1b2e30c4dc4da856ea4cc68
status         success                       receiptStatus: success
block          11618878
gas used       144,637
gas cost       0.000166865066696202 ETH      (paid by a relayer — see "the sender", below)
wall clock     17.515 s                      2026-09-02T10:04:12.096Z → 10:04:29.611Z
```

**What moved:**

| | before | after |
|---|---|---|
| `HERO_A` Safe `0xB870…6169` | 10.00 USDC | **0.00** |
| `PAYEE` `0x6602…05B1` | 0.00 USDC | **10.00** |
| Safe nonce | 0 | **1** |
| `isOwner(executor)` on that Safe | — | **`false`** |

That last row is the product. The address that drained the Safe owns nothing on it, has no
approval, holds no owner slot, and never did.

---

## Reproduce it

`npm test` is the only command that needs no credentials. Everything below hits the real
Transaction Service, the real chain, and the real KeeperHub API.

```bash
npm install
npm test            # 64 tests, ~0.07 s, no network, no keys
```

The full path, in order. Each step is idempotent and each refuses rather than guesses:

```bash
# 1 · see the cast without spending anything
node scripts/seed.mjs status  --chain 11155111

# 2 · manufacture the condition: propose a payout, sign it to threshold, and STOP
node scripts/seed.mjs stage   --chain 11155111 --safe HERO_A --yes

# 3 · run the pure function over the live queue + live chain state, then simulate
node scripts/verify-assemble.mjs --chain 11155111 --safe HERO_A \
     --address 0xB8709787228046C4612D969A153942e1693e6169

# 4 · three gates, then broadcast. THIS is the product.
node scripts/drain.mjs --chain 11155111 \
     --address 0xB8709787228046C4612D969A153942e1693e6169 --execute

# 5 · render the receipts from KeeperHub's own execution rows
node scripts/audit.mjs --chain 11155111 --verify
```

> **On `--execute`.** Step 4 without it runs all three gates and stops before broadcasting.
> That is a **safety default, not a demo mode** — the read, the assembly, the `eth_call` and
> KeeperHub's own `simulate` all execute for real against real state either way. `--execute` is
> an *enabling* flag. There is no flag anywhere in this repo that makes the product pretend.

**Credentials** (never in this tree — see the README): a KeeperHub org API key at
`~/.config/keeperhub/env`, a Safe Transaction Service JWT at `~/.config/gavel/safe-api-key`, and a
BIP-39 mnemonic at `~/.config/gavel/seed.txt` for the seeded cast.

---

## What the three gates actually did on this run

```
[1/3] assemble  EXECUTABLE     Executing nonce 0 with 2 of 2 signatures.
[2/3] eth_call  SUCCEEDS       checkSignatures ACCEPTED the assembled blob
[3/3] KeeperHub simulate  HTTP 200 OK
```

Gate 2 is not decoration. A Safe **guard** can reject a fully-signed transaction with
`InvalidSignatures()`, and `execTransaction` returns `success = false` when the inner call reverts
while the outer call still succeeds — burning gas and permanently consuming the nonce while moving
nothing. Both are refused before broadcast.

---

## Verify it yourself — five surfaces, none of them ours

1. Open [the transaction](https://sepolia.etherscan.io/tx/0xf0b3b61144dc272ce39508056d600f28bbb7b92de1b2e30c4dc4da856ea4cc68) — status `Success`, 144,637 gas, block 11618878.
2. Its **Logs** — a Safe `ExecutionSuccess` and a USDC `Transfer` of `10.000000`.
3. [The Safe's contract](https://sepolia.etherscan.io/address/0xB8709787228046C4612D969A153942e1693e6169#readContract) → `isOwner(0x5E2e5Fd3aD7fDC9B94482930db8b5F45E439bab7)` → **`false`**.
4. Same contract → `nonce` → advanced past the transaction we executed.
5. `src/assemble.mjs` — the entire decision surface, and the file the tests run.

---

## The sender will look wrong

The top-level `From` on that transaction is `0x809D8252…0444`, a relayer, and `To` is a contract
you will not recognise. Our `execTransaction` is an **internal call**, and our executor's ETH
balance is unchanged — it paid no gas.

KeeperHub writes are gas-sponsored by default. But `eth_getCode` on the executor returns
`0xef0100955d84139e7621bc571b117d8eb5d28a4a222c6f` — an **EIP-7702 delegation designator**. The
delegate executes in the EOA's own context, so `msg.sender` at the Safe is still the executor,
which is why its nonce incremented while its balance did not.

**Verify by transaction hash, not by address history.** A sponsored transaction does not appear in
the sending wallet's transaction list, and no amount of scrolling that page will show this run.

---

## Honest limitations

- **This is testnet.** No mainnet execution exists. The headline metric `N` does not exist yet and
  is not claimed anywhere.
- **The decision happened off-platform.** The canonical `gavel-drain` workflow cannot be created on
  our KeeperHub plan — `code/run-code` and `HTTP Request` both require **pro**, and nothing
  discloses that before create time. `drain.mjs` reaches the same on-chain outcome through the
  Direct Execution API, importing the same `assemble.mjs` the tests run. Same decision, same
  execution, **different orchestration** — a weaker answer to "execution *through* KeeperHub",
  and not blurred.
- **The demo is self-seeded.** `HERO_A` is our Safe and the payout was staged by
  `scripts/seed.mjs`. That is disclosed because a number that hides it means less than it looks.
  Third-party demand volume is a separate table and is currently empty.
