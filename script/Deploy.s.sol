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

        // Give yourself 1M USDC and 1000 ETH
        tokenA.mint(deployer, 1_000_000 * 1e6);
        tokenB.mint(deployer, 1_000 * 1e18);

        // 2. Mine Hook Address
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        address create2Deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        (address hookAddress, bytes32 salt) =
            HookMiner.find(create2Deployer, flags, type(VeiledHook).creationCode, abi.encode(POOL_MANAGER, deployer));

        // 3. Deploy Hook
        VeiledHook hook = new VeiledHook{ salt: salt }(IPoolManager(POOL_MANAGER), deployer);
        require(address(hook) == hookAddress, "Hook address mismatch");

        // 4. Initialize Pool (Price 1:1)
        (Currency token0, Currency token1) = address(tokenA) < address(tokenB)
            ? (Currency.wrap(address(tokenA)), Currency.wrap(address(tokenB)))
            : (Currency.wrap(address(tokenB)), Currency.wrap(address(tokenA)));

        PoolKey memory poolKey =
            PoolKey({ currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook)) });

        IPoolManager(POOL_MANAGER).initialize(poolKey, 79228162514264337593543950336);

        // 5. Add Liquidity (So you can trade immediately)
        tokenA.approve(MODIFY_LIQUIDITY_ROUTER, type(uint256).max);
        tokenB.approve(MODIFY_LIQUIDITY_ROUTER, type(uint256).max);
        tokenA.approve(address(hook), type(uint256).max);
        tokenB.approve(address(hook), type(uint256).max);

        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: -600,
            tickUpper: 600,
            liquidityDelta: 10000e6, // Add 10,000 units of liquidity
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
