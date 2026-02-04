// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { BaseHook } from "v4-periphery/src/utils/BaseHook.sol";
import { Hooks } from "v4-core/libraries/Hooks.sol";
import { IPoolManager } from "v4-core/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/types/PoolKey.sol";
import { Currency, CurrencyLibrary } from "v4-core/types/Currency.sol";
import { BalanceDelta } from "v4-core/types/BalanceDelta.sol";
import { BeforeSwapDelta, BeforeSwapDeltaLibrary } from "v4-core/types/BeforeSwapDelta.sol";
import { SwapParams } from "v4-core/types/PoolOperation.sol";
import { IERC20Minimal } from "v4-core/interfaces/external/IERC20Minimal.sol";

contract VeiledHook is BaseHook {
    using CurrencyLibrary for Currency;

    address public immutable agent;
    bool private isSettling;

    error NotAgent();
    // error HookNotImplemented(); // Removed: Shadows BaseHook error

    constructor(IPoolManager _poolManager, address _agent) BaseHook(_poolManager) {
        agent = _agent;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true, // We still observe swaps
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true, // Required for our custom settle flow
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // 1. Observation Logic
    // CRITICAL UPDATE: We allow ALL swaps to pass.
    // This allows you to dump ETH publicly to crash the price.
    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // No Revert here. Public market is open.
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // 2. The Agent Entry Point (Private Order Execution)
    function settle(PoolKey calldata key, SwapParams calldata params, address user) external {
        if (msg.sender != agent) revert NotAgent();

        isSettling = true;
        // Unlock the pool to execute the swap
        poolManager.unlock(abi.encode(key, params, user));
        isSettling = false;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert HookNotImplemented();

        (PoolKey memory key, SwapParams memory params, address user) = abi.decode(data, (PoolKey, SwapParams, address));

        // Execute Swap
        BalanceDelta delta = poolManager.swap(key, params, new bytes(0));

        // ---------------------------------------------------------
        // SETTLEMENT (Who pays?)
        // ---------------------------------------------------------

        // A. If User OWES money (Selling), Pull from User
        if (delta.amount0() < 0) {
            _settle(key.currency0, user, uint256(uint128(-delta.amount0())));
        }
        if (delta.amount1() < 0) {
            _settle(key.currency1, user, uint256(uint128(-delta.amount1())));
        }

        // B. If User EARNS money (Buying), Push to User
        if (delta.amount0() > 0) {
            poolManager.take(key.currency0, user, uint256(uint128(delta.amount0())));
        }
        if (delta.amount1() > 0) {
            poolManager.take(key.currency1, user, uint256(uint128(delta.amount1())));
        }

        return "";
    }

    // Helper: Pull tokens from Payer -> PoolManager
    function _settle(Currency currency, address payer, uint256 amount) internal {
        if (currency.isAddressZero()) {
            poolManager.settle{ value: amount }();
        } else {
            poolManager.sync(currency);
            // NOTE: 'payer' must have approved this Hook contract
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), amount);
            poolManager.settle();
        }
    }
}
