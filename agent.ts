import { WebSocketServer } from 'ws';
import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";
import * as dotenv from "dotenv";
import * as readline from 'readline';
// No SDK import needed - using direct JSON-RPC fetch for ts-node compatibility
const SUI_TESTNET_RPC = 'https://fullnode.testnet.sui.io:443';

dotenv.config();

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY!;
const VEILED_ADDRESS = process.env.VEILED_CONTRACT_ADDRESS!; // Acts as HOOK_ADDR

// Price is now real 3000:1 from pool initialization (no demo scaling needed)

// Uniswap V4 Sepolia Address (Deployed 2026-02-08 - fixed sqrtPriceX96)
const POOL_MANAGER_ADDR = "0x2Bb948982e1fd9C5e740EebDBEA1e0Fc525ee5B2";
const TOKEN0_ADDR = "0x12CEcD540ED55Bd1F800eAC20725CF6713C00BD6"; // vUSDC (Sorted < vETH)
const TOKEN1_ADDR = "0x230e4c771Db09D516F08059C16ee1F8DA0f4DB3E"; // vETH

// Sui Testnet Configuration (Deployed 2026-02-08)
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID || "0xaed9114ecf3e09351956707583ce778bd20875d5da4f4aec3e09c941c9f7b2e7";
const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";
const AGENT_SHARED_SECRET = "veiled-agent-secret-2026"; // Shared with frontend for demo

// Check generic envs
if (!PRIVATE_KEY || !VEILED_ADDRESS) {
    console.error("Missing AGENT_PRIVATE_KEY or VEILED_CONTRACT_ADDRESS in .env");
    process.exit(1);
}

// ---------------------------------------------------------
// ABIS
// ---------------------------------------------------------
const POOL_MANAGER_ABI = [
    "function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"
];

const HOOK_ABI = [
    "function settle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, tuple(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, address user) external"
];

// ---------------------------------------------------------
// TYPES
// ---------------------------------------------------------
interface StrategyPayload {
    intent: string;
    price: number;
    nonce: number;
    user: string;
    sessionSigner: string;
    signature: string;
    amount?: number;
}

// ---------------------------------------------------------
// MEMORY & STATE
// ---------------------------------------------------------
let activeStrategy: StrategyPayload | null = null;
let provider: JsonRpcProvider;
let wallet: Wallet;
let veiledContract: Contract;
let poolManager: Contract;
let poolKey: any;
let wss: WebSocketServer;

// Sui Order State
interface SuiOrderPayload {
    targetPrice: number;
    amount: number;
    direction: 'buy' | 'sell';
    userEthAddress: string;
}

interface SuiOrder {
    orderId: string;
    blobId: string;
    payload: SuiOrderPayload | null;
    processed: boolean;
}

// No SDK client needed - using fetch
let suiOrders: Map<string, SuiOrder> = new Map();
let processedOrderIds: Set<string> = new Set();

// ---------------------------------------------------------
// HELPER: CALCULATE POOL ID
// ---------------------------------------------------------
function getPoolId(key: any) {
    const abiCoder = new ethers.AbiCoder();
    const packed = abiCoder.encode(
        ["address", "address", "uint24", "int24", "address"],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    );
    return ethers.keccak256(packed);
}

// ---------------------------------------------------------
// 1. WebSocket Server (Listener)
// ---------------------------------------------------------
async function startServer() {
    console.log("[Agent] Starting Production WebSocket Server on port 8080...");
    wss = new WebSocketServer({ port: 8080 });

    wss.on('connection', (ws: any) => {
        console.log('[WS] Client connected');

        ws.on('message', async (message: any) => {
            try {
                const data = JSON.parse(message.toString());

                // Only process Strategy Updates
                if (data.intent === "STRATEGY_UPDATE" && data.price && data.signature) {
                    const payloadToVerify = { ...data };
                    delete payloadToVerify.signature;

                    const recovered = ethers.verifyMessage(JSON.stringify(payloadToVerify), data.signature);

                    if (recovered === data.sessionSigner) {
                        console.log(`[WS] ⚡ Strategy Update Verified! Target: $${data.price}`);
                        activeStrategy = data;
                    } else {
                        console.warn(`[WS] Signature mismatch! Recovered: ${recovered}, Expected: ${data.sessionSigner}`);
                    }
                }
            } catch (e) {
                console.error('[WS] Error processing message:', e);
            }
        });
    });
}

// ---------------------------------------------------------
// 2. Market Watch & Execution Loop
// ---------------------------------------------------------
async function startMarketLoop() {
    console.log("[Agent] Starting Main Loop...");

    setInterval(async () => {
        try {
            // Get actual market price (already ~3000 from pool init)
            let marketPrice = await getMarketPrice();

            // Broadcast to Frontends
            if (wss && wss.clients) {
                const update = JSON.stringify({
                    type: "PRICE_UPDATE",
                    price: marketPrice,
                    target: activeStrategy ? activeStrategy.price : null
                });
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(update);
                });
            }

            console.log(`[Chain] Price: $${marketPrice.toFixed(2)} | Target: ${activeStrategy ? '$' + activeStrategy.price : 'None'} | Sui Orders: ${suiOrders.size}`);

            // B. Check Condition (WebSocket strategy)
            if (activeStrategy && marketPrice <= activeStrategy.price) {
                console.log("[Agent] 🚨 TRIGGER HIT! Executing Settlement...");
                await executeSettlement(activeStrategy);
                activeStrategy = null;
            }

            // C. Check Sui Orders
            for (const [orderId, order] of suiOrders) {
                if (order.processed || !order.payload) continue;

                // For buy orders, trigger when price drops to/below target
                // For sell orders, trigger when price rises to/above target
                const shouldTrigger = order.payload.direction === 'buy'
                    ? marketPrice <= order.payload.targetPrice
                    : marketPrice >= order.payload.targetPrice;

                if (shouldTrigger) {
                    console.log(`[Sui] 🚨 Order ${orderId.slice(0, 10)}... TRIGGERED at $${marketPrice.toFixed(2)}`);

                    // Execute on Ethereum
                    const mockStrategy: StrategyPayload = {
                        intent: 'SUI_ORDER',
                        price: order.payload.targetPrice,
                        nonce: Date.now(),
                        user: order.payload.userEthAddress,
                        sessionSigner: order.payload.userEthAddress,
                        signature: '', // Not used for Sui orders
                        amount: order.payload.amount,
                    };

                    await executeSettlement(mockStrategy);
                    order.processed = true;
                    suiOrders.set(orderId, order);
                    console.log(`[Sui] ✅ Order ${orderId.slice(0, 10)}... executed`);
                }
            }
        } catch (e) {
            console.error("[Agent] Loop Error:", e);
        }
    }, 3000);
}

// ---------------------------------------------------------
// 3. Execution (The Settle Logic)
// ---------------------------------------------------------
async function executeSettlement(strategy: StrategyPayload) {
    try {
        const key = (poolKey && poolKey.currency0 !== "0x...") ? poolKey : {
            currency0: ethers.ZeroAddress,
            currency1: ethers.ZeroAddress,
            fee: 3000,
            tickSpacing: 60,
            hooks: VEILED_ADDRESS
        };

        // Valid Limits for Swap
        const MIN_SQRT_RATIO = 4295128739n + 1n;
        const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n - 1n;

        // Dynamic Amount Logic for BUYING ETH with USDC
        // Token0 = vUSDC, Token1 = vETH
        // zeroForOne = true means: token0 → token1 = USDC → ETH = BUY ETH ✓
        // Negative amount = Exact Input (spend this much USDC)
        let finalAmount = -1_000_000n; // Default: spend 1 USDC
        if (strategy.amount) {
            finalAmount = -BigInt(Math.floor(strategy.amount * 1_000_000)); // USDC 6 decimals
        }

        console.log(`[Agent] Executing swap: spend ${-finalAmount} USDC units to buy ETH`);

        const swapParams = {
            zeroForOne: true, // true = swap token0(USDC) for token1(ETH) = BUY ETH
            amountSpecified: finalAmount, // Negative = Exact Input
            sqrtPriceLimitX96: MIN_SQRT_RATIO // Use MIN when zeroForOne=true
        };

        const tx = await veiledContract.settle(
            key,
            swapParams,
            strategy.user
        );

        console.log(`[Agent] Transaction Sent! Hash: ${tx.hash}`);
        console.log(`[Agent] Execution confirmed.`);
    } catch (e) {
        console.error(`[Agent] Execution Failed: ${(e as Error).message}`);
    }
}

// ---------------------------------------------------------
// MARKET DATA (Using Storage Read)
// ---------------------------------------------------------
async function checkPrice(): Promise<number> {
    if (!poolKey || poolKey.currency0 === "0x...") return 0;

    const abiCoder = new ethers.AbiCoder();
    const packed = abiCoder.encode(
        ["address", "address", "uint24", "int24", "address"],
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    );
    const poolId = ethers.keccak256(packed);

    const POOLS_SLOT = 6;
    const slotInput = ethers.solidityPacked(["bytes32", "uint256"], [poolId, POOLS_SLOT]);
    const slot = ethers.keccak256(slotInput);

    try {
        const data = await provider.getStorage(POOL_MANAGER_ADDR, slot);
        const sqrtPriceX96 = BigInt(data) & ((1n << 160n) - 1n);

        if (sqrtPriceX96 === 0n) return 0;

        const Q96 = 2n ** 96n;
        const priceNumer = sqrtPriceX96 * sqrtPriceX96;
        const priceDenom = Q96 * Q96;
        // Raw price from Uniswap = token1/token0 = vETH/vUSDC (in raw units)
        const rawPrice = Number(priceNumer * 1000000n / priceDenom) / 1000000;

        // We want: USDC per ETH (human readable)
        // Token0 = vUSDC (6 decimals), Token1 = vETH (18 decimals)
        // After sqrtPriceX96 fix: rawPrice ≈ 333,000,000 (333M wei per micro-USDC)
        // price in USDC/ETH = 1e18 / (rawPrice * 1e6) = 1e12 / rawPrice
        const price = 1e12 / rawPrice;

        console.log(`[DEBUG] sqrtPriceX96=${sqrtPriceX96}, rawPrice=${rawPrice}, price=${price}`);

        return price;

    } catch (e) {
        console.error("Error fetching pool storage:", e);
        return 0;
    }
}

async function getMarketPrice(): Promise<number> {
    const p = await checkPrice();
    return p;
}

// ---------------------------------------------------------
// MANUAL COMMANDS
// ---------------------------------------------------------
async function manualSwap(direction: 'buy' | 'sell', amountStr: string) {
    console.log(`\n🔄 Initiating Manual ${direction.toUpperCase()}...`);

    try {
        const amount = parseFloat(amountStr || "1");

        // BUY: Want to BUY ETH (Token0) -> Pay USDC (Token1) -> zeroForOne = false
        // SELL: Want to SELL ETH (Token0) -> Receive USDC (Token1) -> zeroForOne = true

        const isSell = direction === 'sell';

        // V4 Params:
        // amountSpecified < 0: Exact Input (Spending X)
        // amountSpecified > 0: Exact Output (Receiving X)

        let amountSpecified: bigint;

        if (isSell) {
            // Selling ETH: "Sell 1 ETH" -> Spend 1 ETH (Exact Input, 18 decimals)
            const wei = ethers.parseEther(amount.toString());
            amountSpecified = -wei;
        } else {
            // Buying ETH with USDC: "Buy 1" -> Spend 1 USDC (Exact Input, 6 decimals)
            const usdc = BigInt(Math.floor(amount * 1_000_000));
            amountSpecified = -usdc; // Negative = Exact Input
        }

        const swapParams = {
            zeroForOne: isSell,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: 0n
        };

        const tx = await veiledContract.settle(poolKey, swapParams, wallet.address);
        console.log(`⏳ Tx Sent: ${tx.hash}`);
        await tx.wait();

        console.log(`✅ ${direction.toUpperCase()} COMPLETE.`);
        const newPrice = await checkPrice();
        console.log(`📊 New Price: $${newPrice.toFixed(2)}`);

    } catch (e) {
        console.error("❌ Swap Failed:", e);
    }
}

async function crashMarket() {
    console.log("\n📉 INITIATING MARKET CRASH (Selling 10 ETH)...");
    await manualSwap('sell', "10");
}

async function placeOrder(priceStr: string) {
    const target = parseFloat(priceStr);
    if (isNaN(target)) {
        console.error("❌ Invalid Price");
        return;
    }

    console.log(`\n🎯 PLACING ORDER: Target $${target.toFixed(2)}`);

    // Set Active Strategy (Simulated from CLI)
    activeStrategy = {
        intent: "CLI_ORDER",
        price: target,
        nonce: Date.now(),
        user: wallet.address, // Agent executes for itself
        sessionSigner: wallet.address,
        signature: "0x" // Bypass signature verification for CLI
    };

    console.log("✅ Order Active. Waiting for price trigger...");
}

// ---------------------------------------------------------
// 7. Sui Order Polling (Encrypted Orders from Walrus)
// ---------------------------------------------------------
async function pollSuiOrders() {
    try {
        // Query OrderCreated events via JSON-RPC
        const response = await fetch(SUI_TESTNET_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'suix_queryEvents',
                params: [{
                    MoveEventType: `${SUI_PACKAGE_ID}::order::OrderCreated`,
                }, null, 50, false]
            })
        });

        const result = await response.json() as { result?: { data: any[] }, error?: any };
        if (!result.result) {
            console.error('[Sui] RPC error:', result.error);
            return;
        }

        const events = result.result.data || [];

        for (const event of events) {
            const orderId = (event.parsedJson as any).order_id;

            // Skip if already processed
            if (processedOrderIds.has(orderId) || suiOrders.has(orderId)) {
                continue;
            }

            // Get blob ID from event
            const blobIdBytes = (event.parsedJson as any).blob_id as number[];
            const blobId = new TextDecoder().decode(new Uint8Array(blobIdBytes));

            console.log(`[Sui] 📦 New order found: ${orderId.slice(0, 10)}... blob: ${blobId.slice(0, 20)}...`);

            // Fetch encrypted blob from Walrus
            try {
                const response = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
                if (!response.ok) {
                    console.warn(`[Sui] Failed to fetch blob: ${response.statusText}`);
                    continue;
                }

                const buffer = await response.arrayBuffer();
                const encrypted = new Uint8Array(buffer);

                // Decrypt payload (XOR with shared secret)
                const secret = new TextEncoder().encode(AGENT_SHARED_SECRET);
                const decrypted = new Uint8Array(encrypted.length);
                for (let i = 0; i < encrypted.length; i++) {
                    decrypted[i] = encrypted[i] ^ secret[i % secret.length];
                }

                const payloadText = new TextDecoder().decode(decrypted);
                const payload = JSON.parse(payloadText) as SuiOrderPayload;

                console.log(`[Sui] 🔓 Decrypted order: ${payload.direction} ${payload.amount} USDC at $${payload.targetPrice}`);

                // Store order for price checking
                suiOrders.set(orderId, {
                    orderId,
                    blobId,
                    payload,
                    processed: false,
                });

            } catch (e) {
                console.warn(`[Sui] Failed to process blob: ${e}`);
            }
        }
    } catch (e) {
        console.error("[Sui] Polling error:", e);
    }
}

// Start Sui polling loop
function startSuiPolling() {
    console.log("[Sui] Starting order polling loop...");

    // Poll every 10 seconds
    setInterval(async () => {
        await pollSuiOrders();
    }, 10000);

    // Initial poll
    pollSuiOrders();
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`[Agent] 🤖 Agent Active: ${wallet.address}`);

    veiledContract = new ethers.Contract(VEILED_ADDRESS, HOOK_ABI, wallet);
    poolManager = new ethers.Contract(POOL_MANAGER_ADDR, POOL_MANAGER_ABI, provider);

    poolKey = {
        currency0: TOKEN0_ADDR,
        currency1: TOKEN1_ADDR,
        fee: 3000,
        tickSpacing: 60,
        hooks: VEILED_ADDRESS
    };

    await startServer();
    startMarketLoop();
    startSuiPolling(); // Start Sui order polling

    if (poolKey.currency0 !== "0x...") {
        const p = await checkPrice();
        if (p > 0) console.log(`📊 Current Uniswap Price: $${p.toFixed(2)}`);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("\n⌨️  COMMANDS: \n- 'order <price>' (Set Target)\n- 'sell <amount>' (Short)\n- 'buy <amount>' (Long)\n- 'crash' (Dump)\n- 'price' (Check)\n- 'sui' (Show Sui orders)\n");

    rl.on('line', (input) => {
        const args = input.trim().split(" ");
        const cmd = args[0];

        if (cmd === 'crash') {
            crashMarket();
        } else if (cmd === 'price') {
            checkPrice().then(p => console.log(`📊 Price: $${p.toFixed(2)}`));
        } else if (cmd === 'buy' || cmd === 'sell') {
            manualSwap(cmd as 'buy' | 'sell', args[1]);
        } else if (cmd === 'order') {
            placeOrder(args[1]);
        } else if (cmd === 'sui') {
            console.log(`\n📦 Sui Orders: ${suiOrders.size}`);
            for (const [id, order] of suiOrders) {
                console.log(`  - ${id.slice(0, 10)}...: ${order.payload?.direction} ${order.payload?.amount} USDC @ $${order.payload?.targetPrice} [${order.processed ? 'DONE' : 'PENDING'}]`);
            }
        }
    });
}

main().catch(console.error);
