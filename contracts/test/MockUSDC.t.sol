// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "../MockUSDC.sol";

/**
 * MockUSDC — full unit suite. 100% line, statement, branch and function coverage.
 *
 * No forge-std. The rest of this repository's decision surface is zero-dependency
 * on purpose, and a token this small does not justify vendoring a library to test
 * it: the four cheatcodes actually needed are declared inline below, and the
 * assertions are three helpers. `forge test` runs it with nothing installed.
 *
 * MockUSDC is TESTNET-ONLY (see the contract notice), but it is still the thing
 * standing under every rehearsal drain — if its `transfer` is wrong, the
 * `inner-call-failed` / GS013 fixture is testing the wrong failure.
 */

/// The subset of Foundry's cheatcode ABI this suite uses. Declaring it here is
/// what keeps `libs = []` true in foundry.toml.
interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function label(address, string calldata) external;
}

contract MockUSDCTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSDC private token;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);

    // Mirrors of the contract's events, so expectEmit has something to match.
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // --- assertions -------------------------------------------------------
    // A reverting test is a failing test in forge, so `require` is the whole
    // assertion library needed here.

    function _eq(uint256 a, uint256 b, string memory what) private pure {
        require(a == b, what);
    }

    function _true(bool c, string memory what) private pure {
        require(c, what);
    }

    function setUp() public {
        token = new MockUSDC();
        vm.label(address(token), "MockUSDC");
    }

    // --- metadata ---------------------------------------------------------

    function test_Metadata() public view {
        _true(
            keccak256(bytes(token.name())) == keccak256(bytes("Mock USD Coin")),
            "name"
        );
        _true(keccak256(bytes(token.symbol())) == keccak256(bytes("mUSDC")), "symbol");
        // Six decimals is load-bearing: seed-data.md writes 250.00 USDC as
        // 250_000000, and the G4 volume fingerprint is in micro-USDC.
        _eq(token.decimals(), 6, "decimals must be 6, matching Circle USDC");
        _eq(token.totalSupply(), 0, "fresh supply");
    }

    // --- mint -------------------------------------------------------------

    function test_Mint_CreditsBalanceAndSupply() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), ALICE, 250_000000);
        token.mint(ALICE, 250_000000);

        _eq(token.balanceOf(ALICE), 250_000000, "alice balance");
        _eq(token.totalSupply(), 250_000000, "supply");
    }

    function test_Mint_IsCumulativeAcrossAccounts() public {
        token.mint(ALICE, 250_000000);
        token.mint(BOB, 32_000000);
        token.mint(ALICE, 1_000001); // the G4 fingerprint shape: 1.000000 + i

        _eq(token.balanceOf(ALICE), 251_000001, "alice cumulative");
        _eq(token.balanceOf(BOB), 32_000000, "bob");
        _eq(token.totalSupply(), 283_000001, "supply is the sum of every mint");
    }

    function test_Mint_ZeroIsANoOp() public {
        token.mint(ALICE, 0);
        _eq(token.balanceOf(ALICE), 0, "zero mint credits nothing");
        _eq(token.totalSupply(), 0, "zero mint raises no supply");
    }

    /// Open mint is deliberate (testnet faucet). Prove any address can call it,
    /// so nobody later "fixes" it into an owner-gated mint and breaks seeding.
    function test_Mint_IsPermissionless() public {
        vm.prank(CAROL);
        token.mint(CAROL, 5_000000);
        _eq(token.balanceOf(CAROL), 5_000000, "any caller may mint");
    }

    // --- transfer ---------------------------------------------------------

    function test_Transfer_MovesValueAndReturnsTrue() public {
        token.mint(ALICE, 100_000000);

        vm.expectEmit(true, true, false, true);
        emit Transfer(ALICE, BOB, 40_000000);

        vm.prank(ALICE);
        bool ok = token.transfer(BOB, 40_000000);

        _true(ok, "transfer returns true");
        _eq(token.balanceOf(ALICE), 60_000000, "sender debited");
        _eq(token.balanceOf(BOB), 40_000000, "recipient credited");
        _eq(token.totalSupply(), 100_000000, "transfer never changes supply");
    }

    /// bal == amount is the boundary of `require(bal >= amount)`.
    function test_Transfer_ExactBalanceEmptiesTheAccount() public {
        token.mint(ALICE, 10_000000);
        vm.prank(ALICE);
        _true(token.transfer(BOB, 10_000000), "exact-balance transfer succeeds");
        _eq(token.balanceOf(ALICE), 0, "drained to zero");
        _eq(token.balanceOf(BOB), 10_000000, "bob holds it all");
    }

    function test_Transfer_ZeroIsAllowed() public {
        vm.prank(ALICE);
        _true(token.transfer(BOB, 0), "zero transfer is legal ERC-20");
        _eq(token.balanceOf(BOB), 0, "nothing moved");
    }

    /// Aliasing: from == to must not mint or burn via the two unchecked writes.
    function test_Transfer_ToSelfIsValuePreserving() public {
        token.mint(ALICE, 7_000000);
        vm.prank(ALICE);
        _true(token.transfer(ALICE, 7_000000), "self-transfer succeeds");
        _eq(token.balanceOf(ALICE), 7_000000, "self-transfer is a no-op on balance");
        _eq(token.totalSupply(), 7_000000, "and cannot inflate supply");
    }

    /// This revert is the one gavel's `inner-call-failed` (GS013) fixture rides on.
    function test_Transfer_RevertsWhenBalanceIsShort() public {
        token.mint(ALICE, 1_000000);
        vm.prank(ALICE);
        vm.expectRevert(bytes("MockUSDC: insufficient balance"));
        token.transfer(BOB, 1_000001);
    }

    function test_Transfer_RevertsFromAnEmptyAccount() public {
        vm.prank(ALICE);
        vm.expectRevert(bytes("MockUSDC: insufficient balance"));
        token.transfer(BOB, 1);
    }

    // --- approve ----------------------------------------------------------

    function test_Approve_SetsAllowanceAndReturnsTrue() public {
        vm.expectEmit(true, true, false, true);
        emit Approval(ALICE, BOB, 25_000000);

        vm.prank(ALICE);
        _true(token.approve(BOB, 25_000000), "approve returns true");
        _eq(token.allowance(ALICE, BOB), 25_000000, "allowance recorded");
    }

    /// Straight overwrite, not an increase — prove it, so nobody assumes otherwise.
    function test_Approve_OverwritesRatherThanAccumulates() public {
        vm.prank(ALICE);
        token.approve(BOB, 25_000000);
        vm.prank(ALICE);
        token.approve(BOB, 4_000000);
        _eq(token.allowance(ALICE, BOB), 4_000000, "second approve replaces the first");
    }

    function test_Approve_AllowancesArePerSpender() public {
        vm.prank(ALICE);
        token.approve(BOB, 1_000000);
        vm.prank(ALICE);
        token.approve(CAROL, 2_000000);
        _eq(token.allowance(ALICE, BOB), 1_000000, "bob");
        _eq(token.allowance(ALICE, CAROL), 2_000000, "carol");
        _eq(token.allowance(BOB, ALICE), 0, "unrelated pair stays zero");
    }

    // --- transferFrom -----------------------------------------------------

    /// Branch: allowed != type(uint256).max — the allowance must be decremented.
    function test_TransferFrom_FiniteAllowanceIsDecremented() public {
        token.mint(ALICE, 100_000000);
        vm.prank(ALICE);
        token.approve(BOB, 60_000000);

        vm.expectEmit(true, true, false, true);
        emit Transfer(ALICE, CAROL, 25_000000);

        vm.prank(BOB);
        _true(token.transferFrom(ALICE, CAROL, 25_000000), "returns true");

        _eq(token.allowance(ALICE, BOB), 35_000000, "allowance debited by the amount");
        _eq(token.balanceOf(ALICE), 75_000000, "owner debited");
        _eq(token.balanceOf(CAROL), 25_000000, "recipient credited");
    }

    /// The other side of that branch: an infinite allowance is left untouched.
    function test_TransferFrom_InfiniteAllowanceIsNotDecremented() public {
        token.mint(ALICE, 100_000000);
        vm.prank(ALICE);
        token.approve(BOB, type(uint256).max);

        vm.prank(BOB);
        _true(token.transferFrom(ALICE, CAROL, 30_000000), "returns true");

        _eq(
            token.allowance(ALICE, BOB),
            type(uint256).max,
            "an infinite allowance must stay infinite"
        );
        _eq(token.balanceOf(CAROL), 30_000000, "value still moved");
    }

    /// allowed == amount: the boundary of `require(allowed >= amount)`.
    function test_TransferFrom_ExactAllowanceIsSpentToZero() public {
        token.mint(ALICE, 50_000000);
        vm.prank(ALICE);
        token.approve(BOB, 50_000000);

        vm.prank(BOB);
        _true(token.transferFrom(ALICE, CAROL, 50_000000), "exact allowance succeeds");
        _eq(token.allowance(ALICE, BOB), 0, "allowance fully consumed");
    }

    function test_TransferFrom_RevertsWhenAllowanceIsShort() public {
        token.mint(ALICE, 100_000000);
        vm.prank(ALICE);
        token.approve(BOB, 10_000000);

        vm.prank(BOB);
        vm.expectRevert(bytes("MockUSDC: insufficient allowance"));
        token.transferFrom(ALICE, CAROL, 10_000001);
    }

    function test_TransferFrom_RevertsWithNoAllowanceAtAll() public {
        token.mint(ALICE, 100_000000);
        vm.prank(BOB);
        vm.expectRevert(bytes("MockUSDC: insufficient allowance"));
        token.transferFrom(ALICE, CAROL, 1);
    }

    /// Allowance sufficient, balance is not — the second require must still fire,
    /// and it must fire before any balance is written.
    function test_TransferFrom_RevertsWhenBalanceIsShortDespiteAllowance() public {
        token.mint(ALICE, 5_000000);
        vm.prank(ALICE);
        token.approve(BOB, type(uint256).max);

        vm.prank(BOB);
        vm.expectRevert(bytes("MockUSDC: insufficient balance"));
        token.transferFrom(ALICE, CAROL, 5_000001);
    }

    function test_TransferFrom_ToSelfIsValuePreserving() public {
        token.mint(ALICE, 9_000000);
        vm.prank(ALICE);
        token.approve(BOB, 9_000000);

        vm.prank(BOB);
        _true(token.transferFrom(ALICE, ALICE, 9_000000), "self transferFrom succeeds");
        _eq(token.balanceOf(ALICE), 9_000000, "balance preserved");
        _eq(token.allowance(ALICE, BOB), 0, "but the allowance is still spent");
    }

    // --- fuzz -------------------------------------------------------------
    // Cheap here, and it covers the arithmetic the unchecked blocks skip.

    function testFuzz_MintThenTransferConservesSupply(uint128 minted, uint128 sent) public {
        vm.prank(ALICE);
        token.mint(ALICE, minted);
        if (sent > minted) return;

        vm.prank(ALICE);
        token.transfer(BOB, sent);

        _eq(token.balanceOf(ALICE) + token.balanceOf(BOB), minted, "value is conserved");
        _eq(token.totalSupply(), minted, "supply is untouched by transfer");
    }
}
