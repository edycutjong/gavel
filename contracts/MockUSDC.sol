// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MockUSDC — the rehearsal token, TESTNET ONLY.
 *
 * gavel moves USDC out of Safe multisigs. On Base mainnet (8453) that is real
 * Circle USDC at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 and this contract is
 * never deployed. On the rehearsal chain it stands in, because what the mechanism
 * exercises is `transfer(address,uint256)` inside `execTransaction` — the token's
 * identity is irrelevant to that, and depending on a faucet is not.
 *
 * Six decimals, matching USDC, so every amount in seed-data.md §3 is literal:
 * 250.00 USDC is 250_000000, and the volume fingerprint (1.000000 + i micro-USDC,
 * invariant G4) works unchanged.
 *
 * Deliberately minimal: no ownership, no pausing, no permit. `mint` is open,
 * because on a testnet an access-controlled faucet is theatre — and this contract
 * MUST NOT be deployed anywhere it could be mistaken for money.
 */
contract MockUSDC {
    string public constant name = "Mock USD Coin";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// Open mint. Testnet only — see the contract notice above.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 bal = balanceOf[msg.sender];
        // gavel's `inner-call-failed` (GS013) fixture depends on this reverting
        // when the Safe is empty, so the message is deliberately explicit.
        require(bal >= amount, "MockUSDC: insufficient balance");
        unchecked {
            balanceOf[msg.sender] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockUSDC: insufficient allowance");
            unchecked { allowance[from][msg.sender] = allowed - amount; }
        }
        uint256 bal = balanceOf[from];
        require(bal >= amount, "MockUSDC: insufficient balance");
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        return true;
    }
}
