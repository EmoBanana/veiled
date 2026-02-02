// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {
    ECDSA
} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {
    MessageHashUtils
} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";

contract Veiled is BaseHook {
    using CurrencyLibrary for Currency;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    address public immutable agent;
    bool private isSettling;

    error InvalidAgentSignature();
    error NeedsSettlement();

    constructor(
        IPoolManager _poolManager,
        address _agent
    ) BaseHook(_poolManager) {
        agent = _agent;
    }

    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    function _beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        if (!isSettling) revert NeedsSettlement();
        return (
            BaseHook.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            0
        );
    }

    function settle(
        PoolKey calldata key,
        SwapParams calldata params,
        address user,
        bytes calldata signature
    ) external {
        bytes32 hash = keccak256(abi.encode(key, params, user, block.chainid));
        bytes32 ethHash = hash.toEthSignedMessageHash();
        address signer = ECDSA.recover(ethHash, signature);

        if (signer != agent) revert InvalidAgentSignature();

        isSettling = true;
        poolManager.unlock(abi.encode(key, params, user));
        isSettling = false;
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revertHookNotImplemented(); // Reuse BaseHook error or generic

        (PoolKey memory key, SwapParams memory params, address user) = abi
            .decode(data, (PoolKey, SwapParams, address));

        BalanceDelta delta = poolManager.swap(key, params, new bytes(0));

        // Handle Settlement (Pay Debt to PM)
        // Negative Delta means we owe the PM
        if (delta.amount0() < 0) {
            _settle(key.currency0, agent, uint256(uint128(-delta.amount0())));
        }
        if (delta.amount1() < 0) {
            _settle(key.currency1, agent, uint256(uint128(-delta.amount1())));
        }

        // Handle Token Taking (Claim Credit to User)
        // Positive Delta means PM owes us
        if (delta.amount0() > 0) {
            poolManager.take(
                key.currency0,
                user,
                uint256(uint128(delta.amount0()))
            );
        }
        if (delta.amount1() > 0) {
            poolManager.take(
                key.currency1,
                user,
                uint256(uint128(delta.amount1()))
            );
        }

        return "";
    }

    function _settle(
        Currency currency,
        address payer,
        uint256 amount
    ) internal {
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(
                payer,
                address(poolManager),
                amount
            );
            poolManager.settle();
        }
    }

    function revertHookNotImplemented() internal pure {
        revert("HookNotImplemented");
    }
}
