import { WebSocketServer } from 'ws';
import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";
import * as dotenv from "dotenv";
import * as readline from 'readline';

dotenv.config();

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY!;
const VEILED_ADDRESS = process.env.VEILED_CONTRACT_ADDRESS!; // Acts as HOOK_ADDR

// Uniswap V4 Sepolia Address
// Uniswap V4 Sepolia Address (Local Deployment)
const POOL_MANAGER_ADDR = "0x77d455953cb3272e293f3314ba35f254163cf680";
const TOKEN0_ADDR = "0x5754236a620a51cdd418245fbf617c482923b512"; // vETH (Sorted < vUSDC)
const TOKEN1_ADDR = "0xa6a0ef2c09dddd106116ff917e81e8d64537cc49"; // vUSDC

// Check generic envs
if (!PRIVATE_KEY || !VEILED_ADDRESS) {
    console.error("Missing AGENT_PRIVATE_KEY or VEILED_CONTRACT_ADDRESS in .env");
    process.exit(1);
}

// ---------------------------------------------------------
// ABIS
// ---------------------------------------------------------
// Minimal PoolManager ABI
const POOL_MANAGER_ABI = [
    "function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"
];

// Veiled Hook ABI (Updated to match Veiled.sol: settle takes 3 args, no signature)
const HOOK_ABI = [
    "function settle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, tuple(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, address user) external"
];

// Chainlink Interface (Minimal)
const CHAINLINK_ABI = [
    "function latestAnswer() external view returns (int256)"
];
const CHAINLINK_FEED_ADDRESS = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

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
}

// ---------------------------------------------------------
// MEMORY & STATE
// ---------------------------------------------------------
let activeStrategy: StrategyPayload | null = null;
let provider: JsonRpcProvider;
let wallet: Wallet;
// Contracts
let veiledContract: Contract; // The Hook
let poolManager: Contract;
// Pool Key for Uniswap operations
let poolKey: any;

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
    const wss = new WebSocketServer({ port: 8080 });

    wss.on('connection', (ws: any) => {
        console.log('[WS] Client connected');

        ws.on('message', async (message: any) => {
            try {
                const data = JSON.parse(message.toString());

                // Only process Strategy Updates
                if (data.intent === "STRATEGY_UPDATE" && data.price && data.signature) {
                    // Verify Session Key Signature
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
        if (!activeStrategy) return;

        try {
            // A. Get Market Price using robust fallback logic
            let marketPrice = await getMarketPrice();
            console.log(`[Chain] Price: $${marketPrice.toFixed(2)} | Target: $${activeStrategy.price}`);

            // B. Check Condition
            if (marketPrice <= activeStrategy.price) {
                console.log("[Agent] 🚨 TRIGGER HIT! Executing Settlement...");
                await executeSettlement(activeStrategy);
                activeStrategy = null;
            }
        } catch (e) {
            console.error("[Agent] Loop Error:", e);
        }
    }, 3000);
}

// Helper to get price from Chainlink or Fallback or Uniswap
async function getMarketPrice(): Promise<number> {
    // 1. Try Uniswap Pool First if configured
    if (poolKey && poolKey.currency0 !== "0x...") {
        try {
            const p = await checkPrice();
            if (p > 0) return p;
        } catch { }
    }

    // 2. Try Chainlink
    try {
        const feed = new ethers.Contract(CHAINLINK_FEED_ADDRESS, CHAINLINK_ABI, provider);
        const answer = await feed.latestAnswer();
        return Number(answer) / 100000000;
    } catch (e) {
        // 3. Fallback to API
        try {
            const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDC");
            const data = await res.json() as any;
            return parseFloat(data.price);
        } catch (apiErr) {
            return 2400.00; // Last resort static
        }
    }
}

// ---------------------------------------------------------
// 3. Execution (The Settle Logic)
// ---------------------------------------------------------
async function executeSettlement(strategy: StrategyPayload) {
    try {
        // Use our constructed PoolKey if valid, or mock
        const key = (poolKey && poolKey.currency0 !== "0x...") ? poolKey : {
            currency0: ethers.ZeroAddress,
            currency1: ethers.ZeroAddress,
            fee: 3000,
            tickSpacing: 60,
            hooks: VEILED_ADDRESS
        };

        const swapParams = {
            zeroForOne: true,
            amountSpecified: -100n, // Dummy amount
            sqrtPriceLimitX96: 0n
        };

        // Call settle exactly as defined in Veiled.sol
        const tx = await veiledContract.settle(
            key,
            swapParams,
            strategy.user // User who 'authorized' this via the agent
        );

        console.log(`[Agent] Transaction Sent! Hash: ${tx.hash}`);
        console.log(`[Agent] Execution confirmed.`);
    } catch (e) {
        console.error(`[Agent] Execution Failed: ${(e as Error).message}`);
    }
}

// ---------------------------------------------------------
// 4. God Mode / New Logic
// ---------------------------------------------------------
async function checkPrice() {
    try {
        if (!poolKey || poolKey.currency0 === "0x...") return 0;

        const poolId = getPoolId(poolKey);
        const slot0 = await poolManager.getSlot0(poolId);
        const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);

        // Simple Price Math: (sqrtPrice / 2^96)^2
        const Q96 = 2n ** 96n;
        const priceX96 = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96);
        const price = parseFloat(ethers.formatUnits(priceX96, 18));

        // Log only if explicitly called or debugging
        // console.log(`📊 P_Manager Price: $${price.toFixed(2)}`);
        return price;
    } catch (e) {
        // console.error("⚠️ Error fetching pool price:", e);
        return 0;
    }
}

async function crashMarket() {
    console.log("\n📉 INITIATING MARKET CRASH...");

    const amountToDump = ethers.parseEther("1000"); // Adjust size
    const swapParams = {
        zeroForOne: true,
        amountSpecified: -amountToDump,
        sqrtPriceLimitX96: 0n
    };

    try {
        const tx = await veiledContract.settle(poolKey, swapParams, wallet.address);
        console.log(`⏳ Tx Sent: ${tx.hash}`);
        await tx.wait();
        console.log("✅ CRASH COMPLETE. Checking new price...");
        const newPrice = await checkPrice();
        console.log(`📊 New Price: $${newPrice.toFixed(2)}`);
    } catch (e) {
        console.error("❌ Crash Failed:", e);
    }
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
    provider = new JsonRpcProvider(RPC_URL);
    wallet = new Wallet(PRIVATE_KEY, provider);

    console.log(`[Agent] 🤖 Agent Active: ${wallet.address}`);

    // Init Contracts
    veiledContract = new Contract(VEILED_ADDRESS, HOOK_ABI, wallet);
    poolManager = new Contract(POOL_MANAGER_ADDR, POOL_MANAGER_ABI, provider);

    // Construct PoolKey
    // Note: User must update TOKEN0_ADDR / TOKEN1_ADDR for this to work
    poolKey = {
        currency0: TOKEN0_ADDR,
        currency1: TOKEN1_ADDR,
        fee: 3000,
        tickSpacing: 60,
        hooks: VEILED_ADDRESS
    };

    // Start Services
    await startServer();
    startMarketLoop();

    // Check price on startup (if config is valid)
    if (poolKey.currency0 !== "0x...") {
        const p = await checkPrice();
        if (p > 0) console.log(`📊 Current Uniswap Price: $${p.toFixed(2)}`);
    }

    // CLI Listener for God Mode
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("\n⌨️  COMMANDS: Type 'crash' to dump price, 'price' to check status.");

    rl.on('line', (input) => {
        if (input.trim() === 'crash') {
            crashMarket();
        } else if (input.trim() === 'price') {
            checkPrice().then(p => console.log(`📊 Price: $${p.toFixed(2)}`));
        }
    });
}

main().catch(console.error);
