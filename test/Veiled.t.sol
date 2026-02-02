// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core-test/utils/Deployers.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {
    SwapParams,
    ModifyLiquidityParams
} from "v4-core/types/PoolOperation.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {
    ECDSA
} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {
    MessageHashUtils
} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {Veiled} from "../src/Veiled.sol";

contract VeiledTest is Test, Deployers {
    using CurrencyLibrary for Currency;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    Veiled hook;

    uint256 internal constant AGENT_PK = 0xA11CE;
    address internal AGENT;
    address internal USER = address(0xB0B);

    function setUp() public {
        AGENT = vm.addr(AGENT_PK);

        deployFreshManagerAndRouters();

        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );

        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            flags,
            type(Veiled).creationCode,
            abi.encode(manager, AGENT)
        );

        hook = new Veiled{salt: salt}(manager, AGENT);
        require(address(hook) == hookAddress, "Hook address mismatch");

        (currency0, currency1) = deployMintAndApprove2Currencies();

        key = PoolKey(currency0, currency1, 3000, 60, IHooks(address(hook)));

        manager.initialize(key, SQRT_PRICE_1_1);

        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -60,
                tickUpper: 60,
                liquidityDelta: 1000 ether,
                salt: bytes32(0)
            }),
            new bytes(0)
        );

        MockERC20(Currency.unwrap(currency0)).mint(AGENT, 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(AGENT, 1000 ether);
    }

    function test_SettleParams_Authorized() public {
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -1 ether,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        bytes32 hash = keccak256(abi.encode(key, params, USER, block.chainid));
        bytes32 ethHash = hash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, ethHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.startPrank(AGENT);
        MockERC20(Currency.unwrap(currency0)).approve(
            address(hook),
            type(uint256).max
        );

        uint256 userBalBefore = currency1.balanceOf(USER);

        hook.settle(key, params, USER, signature);

        vm.stopPrank();

        uint256 userBalAfter = currency1.balanceOf(USER);
        assertGt(
            userBalAfter,
            userBalBefore,
            "User should receive output tokens"
        );
    }

    function test_Revert_BadSignature() public {
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -1 ether,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        uint256 badPk = 0xBAD;
        bytes32 hash = keccak256(abi.encode(key, params, USER, block.chainid));
        bytes32 ethHash = hash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(badPk, ethHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.startPrank(AGENT);
        MockERC20(Currency.unwrap(currency0)).approve(
            address(hook),
            type(uint256).max
        );

        vm.expectRevert(Veiled.InvalidAgentSignature.selector);
        hook.settle(key, params, USER, signature);
        vm.stopPrank();
    }

    function test_Revert_DirectSwap() public {
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -1 ether,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        PoolSwapTest.TestSettings memory settings = PoolSwapTest.TestSettings({
            takeClaims: false,
            settleUsingBurn: false
        });

        vm.expectRevert();
        swapRouter.swap(key, params, settings, new bytes(0));
    }
}
