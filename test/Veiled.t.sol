// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import "forge-std/console.sol";
import { Deployers } from "v4-core-test/utils/Deployers.sol";
import { MockERC20 } from "solmate/src/test/utils/mocks/MockERC20.sol";
import { PoolSwapTest } from "v4-core/test/PoolSwapTest.sol";
import { PoolKey } from "v4-core/types/PoolKey.sol";
import { SwapParams, ModifyLiquidityParams } from "v4-core/types/PoolOperation.sol";
import { Currency, CurrencyLibrary } from "v4-core/types/Currency.sol";
import { Hooks } from "v4-core/libraries/Hooks.sol";
import { IHooks } from "v4-core/interfaces/IHooks.sol";
import { HookMiner } from "v4-periphery/src/utils/HookMiner.sol";
import { VeiledHook } from "../src/Veiled.sol";

contract VeiledTest is Test, Deployers {
    using CurrencyLibrary for Currency;

    VeiledHook hook;
    uint256 internal constant AGENT_PK = 0xA11CE;
    address internal AGENT;
    address internal USER = address(0xB0B);

    function setUp() public {
        AGENT = vm.addr(AGENT_PK);
        deployFreshManagerAndRouters();

        // Mine salt for flags: 1000... (BeforeSwap + ReturnDelta)
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(VeiledHook).creationCode, abi.encode(manager, AGENT));

        hook = new VeiledHook{ salt: salt }(manager, AGENT);
        require(address(hook) == hookAddress, "Hook address mismatch");

        (currency0, currency1) = deployMintAndApprove2Currencies();
        key = PoolKey(currency0, currency1, 3000, 60, IHooks(address(hook)));
        manager.initialize(key, SQRT_PRICE_1_1);

        // Add initial liquidity
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({ tickLower: -60, tickUpper: 60, liquidityDelta: 1000 ether, salt: bytes32(0) }),
            new bytes(0)
        );

        // FIX: Mint to USER, not AGENT (User pays for the swap)
        MockERC20(Currency.unwrap(currency0)).mint(USER, 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(USER, 1000 ether);
    }

    function test_SettleParams_Authorized() public {
        SwapParams memory params =
            SwapParams({ zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT });

        uint256 userBalBefore = currency1.balanceOf(USER);

        // 1. User Must Approve Hook
        vm.startPrank(USER);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        // 2. Agent Executes Settle
        vm.startPrank(AGENT);
        hook.settle(key, params, USER);
        vm.stopPrank();

        uint256 userBalAfter = currency1.balanceOf(USER);
        assertGt(userBalAfter, userBalBefore, "User should receive output tokens");
    }

    function test_Revert_UnauthorizedCaller() public {
        SwapParams memory params =
            SwapParams({ zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT });

        address unauthorized = address(0xDEAD);
        vm.startPrank(unauthorized);
        vm.expectRevert(VeiledHook.NotAgent.selector);
        hook.settle(key, params, USER);
        vm.stopPrank();
    }

    function test_StaticOrder_Executes_After_Market_Crash() public {
        // 1. "PLACEMENT" PHASE
        // User approves the hook (This represents "Placing" the order)
        vm.startPrank(USER);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        // -------------------------------------------------------
        // 2. "STORAGE" PHASE (Time Passes, Market Moves)
        // -------------------------------------------------------

        // Simulate a massive market crash (Public dump of ETH)
        // This changes the pool price while the order is "sitting in storage"
        vm.startPrank(address(this)); // The Test Contract acts as a random whale

        // Swap 100 ETH to crash price (Sell ETH -> Buy USDC)
        SwapParams memory crashParams =
            SwapParams({ zeroForOne: false, amountSpecified: -100 ether, sqrtPriceLimitX96: MAX_PRICE_LIMIT });

        // We use a separate router or direct manager call to simulate public trading
        // For simplicity in test, we just call swap directly via manager
        PoolSwapTest.TestSettings memory settings =
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false });

        swapRouter.swap(key, crashParams, settings, new bytes(0));
        vm.stopPrank();

        // -------------------------------------------------------
        // 3. "EXECUTION" PHASE (Agent Wakes Up)
        // -------------------------------------------------------

        // Now the Agent sees the price is low enough and executes the "Stored" order
        SwapParams memory limitOrderParams = SwapParams({
            zeroForOne: true, // Buy ETH (Spend USDC -> Get ETH)
            amountSpecified: -1000 ether, // Spend 1000 USDC
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        uint256 userEthBefore = currency1.balanceOf(USER);

        vm.startPrank(AGENT);
        hook.settle(key, limitOrderParams, USER); // <--- EXECUTION HAPPENS HERE
        vm.stopPrank();

        uint256 userEthAfter = currency1.balanceOf(USER);

        console.log("User Bought ETH Amount:", userEthAfter - userEthBefore);
        assertGt(userEthAfter, userEthBefore, "Limit Order should execute after crash");
    }

    function test_Revert_If_User_Revokes_Approval() public {
        SwapParams memory params =
            SwapParams({ zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT });

        // 1. User Approves initially ("Placing Order")
        vm.startPrank(USER);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        // 2. User acts malicious: REVOKES Approval (Sets to 0)
        vm.startPrank(USER);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), 0);
        vm.stopPrank();

        // 3. Agent tries to execute
        vm.startPrank(AGENT);
        // Expect revert because transferFrom will fail
        vm.expectRevert();
        hook.settle(key, params, USER);
        vm.stopPrank();
    }

    function test_Revert_If_User_Has_No_Funds() public {
        SwapParams memory params =
            SwapParams({ zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT });

        // 1. User Approves
        vm.startPrank(USER);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);

        // 2. User drains their own wallet (transfers everything to burn address)
        uint256 balance = MockERC20(Currency.unwrap(currency0)).balanceOf(USER);
        MockERC20(Currency.unwrap(currency0)).transfer(address(0xDEAD), balance);
        vm.stopPrank();

        // 3. Agent tries to execute
        vm.startPrank(AGENT);
        vm.expectRevert(); // Should fail "transfer amount exceeds balance"
        hook.settle(key, params, USER);
        vm.stopPrank();
    }

    function test_Revert_If_Price_Exceeds_Limit() public {
        // 1. User Approves
        vm.startPrank(USER);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        // 2. Define Strict Limits
        // We set a limit that is effectively impossible to fill given current price
        SwapParams memory tightParams = SwapParams({
            zeroForOne: true,
            amountSpecified: -1 ether,
            sqrtPriceLimitX96: SQRT_PRICE_1_1 // Asking for exact 1:1 execution or better
         });

        // 3. Move market SLIGHTLY against the trade so the limit is hit
        // (You can simulate a small swap here like in your market crash test)

        // 4. Agent tries to execute with Bad Params
        vm.startPrank(AGENT);
        // Depending on v4 core, this reverts with "PriceLimitAlreadyExceeded" or similar
        vm.expectRevert();
        hook.settle(key, tightParams, USER);
        vm.stopPrank();
    }
}
