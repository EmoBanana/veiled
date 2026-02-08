// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { PoolManager } from "v4-core/PoolManager.sol";
import { IPoolManager } from "v4-core/interfaces/IPoolManager.sol";
import { PoolKey } from "v4-core/types/PoolKey.sol";
import { Currency } from "v4-core/types/Currency.sol";
import { IHooks } from "v4-core/interfaces/IHooks.sol";
import { ModifyLiquidityParams } from "v4-core/types/PoolOperation.sol";
import { Hooks } from "v4-core/libraries/Hooks.sol";
import { HookMiner } from "v4-periphery/src/utils/HookMiner.sol";
import { VeiledHook } from "../src/Veiled.sol";
import { MockERC20 } from "../src/MockERC20.sol";
import { PoolModifyLiquidityTest } from "v4-core/test/PoolModifyLiquidityTest.sol";
import "forge-std/console.sol";

contract DeployVeiled is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        // 0. Deploy Manager & Router
        PoolManager manager = new PoolManager(deployer);
        address POOL_MANAGER = address(manager);

        // Deploy ModifyLiquidityRouter (Simplified: We act as the router for now or deploy a mock)
        // Since compiling full PositionManager is complex, we will use a test router from v4-core/test/utils/
        PoolModifyLiquidityTest modifyLiquidityRouter = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        address MODIFY_LIQUIDITY_ROUTER = address(modifyLiquidityRouter);

        // 1. Deploy & Mint Tokens
        MockERC20 tokenA = new MockERC20("Veiled USDC", "vUSDC", 6);
        MockERC20 tokenB = new MockERC20("Veiled ETH", "vETH", 18);

        // Give yourself 100M USDC and 100K ETH for large liquidity pool
        tokenA.mint(deployer, 100_000_000 * 1e6); // 100M USDC
        tokenB.mint(deployer, 100_000 * 1e18); // 100K ETH

        // 2. Mine Hook Address
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        address create2Deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        (address hookAddress, bytes32 salt) =
            HookMiner.find(create2Deployer, flags, type(VeiledHook).creationCode, abi.encode(POOL_MANAGER, deployer));

        // 3. Deploy Hook
        VeiledHook hook = new VeiledHook{ salt: salt }(IPoolManager(POOL_MANAGER), deployer);
        require(address(hook) == hookAddress, "Hook address mismatch");

        // 4. Initialize Pool (Price: 1 ETH = 3000 USDC)
        // Token ordering: token0 < token1 by address
        // Price in Uniswap V4 = token1/token0
        //
        // vUSDC has 6 decimals, vETH has 18 decimals
        // If vETH is token0: raw_price = (3000 * 1e6) / 1e18 = 3000 * 1e-12
        // sqrtPriceX96 = sqrt(3000 * 1e-12) * 2^96 = sqrt(3e-9) * 2^96
        //              = 5.477e-5 * 7.92e28 = 4.34e24
        //
        // If vUSDC is token0: raw_price = 1e18 / (3000 * 1e6) = 1e12 / 3000
        // sqrtPriceX96 = sqrt(1e12 / 3000) * 2^96 = sqrt(3.33e8) * 2^96
        //              = 18257 * 7.92e28 = 1.446e33

        (Currency token0, Currency token1) = address(tokenA) < address(tokenB)
            ? (Currency.wrap(address(tokenA)), Currency.wrap(address(tokenB)))
            : (Currency.wrap(address(tokenB)), Currency.wrap(address(tokenA)));

        PoolKey memory poolKey =
            PoolKey({ currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook)) });

        // Calculate sqrtPriceX96 based on token ordering
        // vUSDC (tokenA) has smaller deployment address typically, so likely token0
        uint160 sqrtPriceX96;
        if (address(tokenA) < address(tokenB)) {
            // tokenA (USDC) is token0, tokenB (ETH) is token1
            // Price = ETH/USDC in raw terms = 1e18 / (3000 * 1e6) = 333333333.33
            // sqrtPrice = sqrt(333333333.33) = 18257.42
            // sqrtPriceX96 = 18257.42 * 2^96 = 1.446e33 (NOT 1.446e30!)
            sqrtPriceX96 = 1445891627926823174640128639795000; // Fixed: *1000
        } else {
            // tokenB (ETH) is token0, tokenA (USDC) is token1
            // Price = USDC/ETH in raw terms = (3000 * 1e6) / 1e18 = 3e-9
            // sqrtPrice = sqrt(3e-9) = 5.477e-5
            // sqrtPriceX96 = 5.477e-5 * 2^96 = 4.34e24 (NOT 4.34e21!)
            sqrtPriceX96 = 4339505179874779070776545000; // Fixed: *1000
        }

        IPoolManager(POOL_MANAGER).initialize(poolKey, sqrtPriceX96);

        // 5. Add Liquidity (So you can trade immediately)
        tokenA.approve(MODIFY_LIQUIDITY_ROUTER, type(uint256).max);
        tokenB.approve(MODIFY_LIQUIDITY_ROUTER, type(uint256).max);
        tokenA.approve(address(hook), type(uint256).max);
        tokenB.approve(address(hook), type(uint256).max);

        // Use max tick range for full-range liquidity (must be divisible by tickSpacing=60)
        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: -887220, // Near min tick (~-887272), divisible by 60
            tickUpper: 887220, // Near max tick (~887272), divisible by 60
            liquidityDelta: 10_000_000e6, // Add 10M units of liquidity
            salt: 0
        });

        PoolModifyLiquidityTest(MODIFY_LIQUIDITY_ROUTER).modifyLiquidity(poolKey, params, new bytes(0));

        vm.stopBroadcast();

        console.log("-----------------------------------------");
        console.log("Token0:", Currency.unwrap(token0));
        console.log("Token1:", Currency.unwrap(token1));
        console.log("Hook:", address(hook));
        console.log("-----------------------------------------");
    }
}
