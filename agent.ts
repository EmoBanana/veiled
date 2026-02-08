import { WebSocketServer, WebSocket } from 'ws';
import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";
import * as dotenv from "dotenv";
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// Persistence for event cursor and pending orders
const STATE_FILE = path.join(process.cwd(), '.agent_state.json');

interface AgentState {
    cursor: { txDigest: string; eventSeq: string } | null;
    processedCount: number;
    pendingOrders: Array<{
        orderId: string;
        blobId: string;
        payload: {
            targetPrice: number;
            amount: number;
            direction: 'buy' | 'sell';
            userEthAddress: string;
        };
    }>;
}

function loadState(): AgentState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            if (data.cursor) {
                console.log(`[Persistence] Resuming from cursor: tx=${data.cursor.txDigest.slice(0, 10)}... (${data.processedCount} orders processed)`);
            }
            if (data.pendingOrders?.length > 0) {
                console.log(`[Persistence] Loaded ${data.pendingOrders.length} pending order(s)`);
            }
            return data;
        }
    } catch (e) {
        console.warn(`[Persistence] Failed to load state: ${e}`);
    }
    return { cursor: null, processedCount: 0, pendingOrders: [] };
}

function saveState() {
    try {
        // Save pending orders (not yet executed)
        const pending = [...suiOrders.values()]
            .filter(o => !o.processed && o.payload)
            .map(o => ({
                orderId: o.orderId,
                blobId: o.blobId,
                payload: o.payload!,
            }));

        const state: AgentState = {
            cursor: agentState.cursor,
            processedCount: agentState.processedCount,
            pendingOrders: pending,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.warn(`[Persistence] Failed to save state: ${e}`);
    }
}

let agentState = loadState();

// ---------------------------------------------------------
// Dynamic Orders (Yellow Network Dev Mode)
// ---------------------------------------------------------
interface DynamicOrder {
    id: string;
    direction: 'buy' | 'sell';
    trailingOffset: number;
    amount: number;
    currentTarget: number;
    userAddress: string;
    ws: WebSocket;
    status: 'active' | 'triggered' | 'executed' | 'failed';
    extremePrice?: number; // Lowest for buy, highest for sell
}

const dynamicOrders = new Map<string, DynamicOrder>();

// Sui modules loaded at runtime (ESM-only packages)
let suiJsonRpcModule: { SuiJsonRpcClient: any; getJsonRpcFullnodeUrl: any } | null = null;
let suiTransactionModule: { Transaction: any } | null = null;
let suiKeypairModule: { Ed25519Keypair: any } | null = null;
let sealModule: { SealClient: any; SessionKey: any; EncryptedObject: any } | null = null;

async function getSuiJsonRpc(): Promise<{ SuiJsonRpcClient: any; getJsonRpcFullnodeUrl: any }> {
    if (!suiJsonRpcModule) suiJsonRpcModule = await import('@mysten/sui/jsonRpc');
    return suiJsonRpcModule;
}

async function getSuiTransaction(): Promise<{ Transaction: any }> {
    if (!suiTransactionModule) suiTransactionModule = await import('@mysten/sui/transactions');
    return suiTransactionModule;
}

async function getSuiKeypair(): Promise<{ Ed25519Keypair: any }> {
    if (!suiKeypairModule) suiKeypairModule = await import('@mysten/sui/keypairs/ed25519');
    return suiKeypairModule;
}

async function getSealModule(): Promise<{ SealClient: any; SessionKey: any; EncryptedObject: any }> {
    if (!sealModule) sealModule = await import('@mysten/seal');
    return sealModule;
}

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
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID || "0xa0418d4c65c9ff236ec7bb8f650d88ddab6ee42cf31ce41f288e493dcf3df29e";
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY; // Agent's Sui key for creating orders
const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";
const WALRUS_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";

// Seal Testnet key servers (Open mode - Mysten Labs)
const SEAL_TESTNET_KEY_SERVERS = [
    '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
    '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
];
const SEAL_THRESHOLD = 2;

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
    direction?: 'buy' | 'sell';
}

// ---------------------------------------------------------
// MEMORY & STATE
// ---------------------------------------------------------
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
    signature?: string;
}

// EIP-712 Domain and Types (Must match frontend)
const VEILED_DOMAIN = {
    name: 'Veiled Protocol',
    version: '1',
    chainId: 11155111,
    verifyingContract: '0x0000000000000000000000000000000000000000',
};

const ORDER_TYPES = {
    Order: [
        { name: 'targetPrice', type: 'uint256' },
        { name: 'amount', type: 'uint256' },
        { name: 'direction', type: 'string' },
        { name: 'userEthAddress', type: 'address' },
    ],
};

function verifySignature(payload: SuiOrderPayload): boolean {
    if (!payload.signature) return false;

    try {
        const signer = ethers.verifyTypedData(
            VEILED_DOMAIN,
            ORDER_TYPES,
            {
                targetPrice: payload.targetPrice,
                amount: BigInt(Math.floor(payload.amount * 1_000_000)), // Convert to atomic units (USDC 6 decimals)
                direction: payload.direction,
                userEthAddress: payload.userEthAddress,
            },
            payload.signature
        );
        return signer.toLowerCase() === payload.userEthAddress.toLowerCase();
    } catch (e) {
        console.error("Signature verification failed:", e);
        return false;
    }
}

interface SuiOrder {
    orderId: string;
    blobId: string;
    payload: SuiOrderPayload | null;
    processed: boolean;
}

let suiClient: any;
let suiSigner: any; // Ed25519Keypair for agent's Sui transactions
let sealClient: any; // Seal SDK client for decryption
let suiOrders: Map<string, SuiOrder> = new Map();

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

    wss.on('connection', (ws: WebSocket) => {
        console.log('[WS] Client connected');

        ws.on('message', async (rawMessage: Buffer) => {
            try {
                const message = JSON.parse(rawMessage.toString());

                if (message.type === "CREATE_ORDER") {
                    console.log('[WS] Received CREATE_ORDER request');
                    await handleCreateOrder(ws, message.encryptedPayload);
                } else if (message.type === "CREATE_DYNAMIC_ORDER") {
                    console.log('[WS] Received CREATE_DYNAMIC_ORDER request');
                    handleCreateDynamicOrder(ws, message.order);
                } else if (message.type === "UPDATE_DYNAMIC_ORDER") {
                    // Handle dynamic order updates (price/amount changes)
                    handleUpdateDynamicOrder(ws, message);
                } else if (message.type === "MANUAL_SWAP") {
                    // Manual swap via WebSocket for testing
                    const { direction, amount } = message;
                    console.log(`[WS] Manual ${direction} ${amount}`);
                    await manualSwap(direction, amount.toString());
                    ws.send(JSON.stringify({ type: "SWAP_COMPLETE", direction, amount }));
                }
            } catch (e) {
                // Ignore non-JSON messages
            }
        });
    });
}

// ---------------------------------------------------------
// Handle CREATE_ORDER: Upload to Walrus + Create Sui order
// ---------------------------------------------------------
async function handleCreateOrder(ws: WebSocket, encryptedPayload: number[]) {
    try {
        if (!SUI_PRIVATE_KEY) {
            throw new Error("SUI_PRIVATE_KEY not configured - agent cannot create orders");
        }

        const encrypted = new Uint8Array(encryptedPayload);
        console.log(`[Agent] Received encrypted order: ${encrypted.length} bytes`);

        // 1. Upload to Walrus
        console.log('[Agent] Uploading to Walrus...');
        const blobId = await uploadToWalrus(encrypted);
        console.log(`[Agent] ✅ Uploaded to Walrus: ${blobId.slice(0, 20)}...`);

        // 2. Create order on Sui
        console.log('[Agent] Creating order on Sui...');
        const digest = await createSuiOrder(blobId);
        console.log(`[Agent] ✅ Order created on Sui: ${digest}`);

        // 3. Send success response to client
        ws.send(JSON.stringify({
            type: "ORDER_CREATED",
            blobId,
            digest,
        }));

    } catch (e) {
        console.error('[Agent] CREATE_ORDER failed:', e);
        ws.send(JSON.stringify({
            type: "ORDER_ERROR",
            error: (e as Error).message,
        }));
    }
}

// ---------------------------------------------------------
// Handle CREATE_DYNAMIC_ORDER: Yellow Network Dev Mode
// ---------------------------------------------------------
function handleCreateDynamicOrder(ws: WebSocket, order: any) {
    try {
        const dynamicOrder: DynamicOrder = {
            id: order.id,
            direction: order.direction,
            trailingOffset: order.trailingOffset,
            amount: order.amount,
            currentTarget: order.currentTarget,
            userAddress: order.userAddress,
            ws,
            status: 'active',
        };

        dynamicOrders.set(order.id, dynamicOrder);
        console.log(`[Yellow] ⚡ Dynamic order created: ${order.direction.toUpperCase()} $${order.amount} trailing $${order.trailingOffset}`);

        ws.send(JSON.stringify({
            type: "DYNAMIC_ORDER_CREATED",
            orderId: order.id,
        }));
    } catch (e) {
        console.error('[Yellow] CREATE_DYNAMIC_ORDER failed:', e);
        ws.send(JSON.stringify({
            type: "ORDER_ERROR",
            error: (e as Error).message,
        }));
    }
}

// ---------------------------------------------------------
// Handle UPDATE_DYNAMIC_ORDER: Update active order params
// ---------------------------------------------------------
function handleUpdateDynamicOrder(ws: WebSocket, message: any) {
    const { orderId, newTarget, newAmount, newTrailingOffset } = message;
    const order = dynamicOrders.get(orderId);

    if (!order) return;

    // Only allow updates if specific fields are provided
    if (newTarget !== undefined) order.currentTarget = newTarget;
    if (newAmount !== undefined) order.amount = newAmount;
    if (newTrailingOffset !== undefined) order.trailingOffset = newTrailingOffset;

    console.log(`[Yellow] 🔄 Order ${orderId.slice(0, 12)} updated: Target $${order.currentTarget.toFixed(2)} | Trailing $${order.trailingOffset} | Amount ${order.amount}`);
}

// ---------------------------------------------------------
// Upload encrypted blob to Walrus Publisher
// ---------------------------------------------------------
async function uploadToWalrus(data: Uint8Array): Promise<string> {
    const response = await fetch(`${WALRUS_PUBLISHER}/v1/blobs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(data),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Walrus upload failed: ${response.status} - ${errText}`);
    }

    const result = await response.json();

    if (result.newlyCreated) {
        return result.newlyCreated.blobObject.blobId;
    } else if (result.alreadyCertified) {
        return result.alreadyCertified.blobId;
    }

    throw new Error('Unexpected Walrus response format');
}

// ---------------------------------------------------------
// Create order on Sui with agent's key
// ---------------------------------------------------------
async function createSuiOrder(blobId: string): Promise<string> {
    if (!suiClient || !suiSigner) {
        await initSuiClient();
    }

    const { Transaction } = await getSuiTransaction();
    const tx = new Transaction();

    tx.moveCall({
        target: `${SUI_PACKAGE_ID}::order::create_order`,
        arguments: [
            tx.pure.vector('u8', Array.from(new TextEncoder().encode(blobId))),
        ],
    });

    const result = await suiClient.signAndExecuteTransaction({
        signer: suiSigner,
        transaction: tx,
    });

    return result.digest;
}

// ---------------------------------------------------------
// Initialize Sui client, signer, and Seal client
// ---------------------------------------------------------
async function initSuiClient() {
    const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await getSuiJsonRpc();
    const { Ed25519Keypair } = await getSuiKeypair();
    const { SealClient } = await getSealModule();

    suiClient = new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl('testnet'),
        network: 'testnet'
    });

    if (SUI_PRIVATE_KEY) {
        // Support both base64 and hex formats
        if (SUI_PRIVATE_KEY.startsWith('suiprivkey')) {
            suiSigner = Ed25519Keypair.fromSecretKey(SUI_PRIVATE_KEY);
        } else if (SUI_PRIVATE_KEY.startsWith('0x')) {
            // Hex format (32 bytes = 64 hex chars)
            const bytes = Buffer.from(SUI_PRIVATE_KEY.slice(2), 'hex');
            suiSigner = Ed25519Keypair.fromSecretKey(bytes);
        } else {
            // Try base64
            const bytes = Buffer.from(SUI_PRIVATE_KEY, 'base64');
            suiSigner = Ed25519Keypair.fromSecretKey(bytes);
        }
        console.log(`[Sui] Agent address: ${suiSigner.getPublicKey().toSuiAddress()}`);
    }

    // Initialize Seal client for decryption
    sealClient = new SealClient({
        suiClient: suiClient as any,
        serverConfigs: SEAL_TESTNET_KEY_SERVERS.map((objectId) => ({ objectId, weight: 1 })),
        verifyKeyServers: false,
    });
    console.log(`[Seal] Seal client initialized with ${SEAL_TESTNET_KEY_SERVERS.length} key servers`);
}

// ---------------------------------------------------------
// 2. Market Watch & Execution Loop
// ---------------------------------------------------------
let lastLoggedPrice = 0;
let loggedPendingOrderIds = new Set<string>();

async function startMarketLoop() {
    console.log("[Agent] Starting Main Loop...");

    setInterval(async () => {
        try {
            // Get actual market price (already ~3000 from pool init)
            let marketPrice = await getMarketPrice();

            // Broadcast price to frontends (no order data over WS)
            if (wss && wss.clients) {
                const update = JSON.stringify({ type: "PRICE_UPDATE", price: marketPrice });
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(update);
                });
            }

            // Log price only when it changes significantly (> $1)
            if (Math.abs(marketPrice - lastLoggedPrice) > 1) {
                console.log(`[Agent] 📊 Price: $${marketPrice.toFixed(2)}`);
                lastLoggedPrice = marketPrice;
            }

            // Log pending orders only once when they're first seen
            const pendingOrders = [...suiOrders.values()].filter(o => !o.processed && o.payload);
            for (const order of pendingOrders) {
                if (!loggedPendingOrderIds.has(order.orderId)) {
                    const p = order.payload!;
                    console.log(`[Agent] ⏳ Pending: ${p.direction.toUpperCase()} ${p.amount} USDC @ $${p.targetPrice}`);
                    loggedPendingOrderIds.add(order.orderId);
                }
            }

            // Check Sui orders (agent decrypts blob from Walrus to get order)
            for (const [orderId, order] of suiOrders) {
                if (order.processed || !order.payload) continue;

                // For buy orders, trigger when price drops to/below target
                // For sell orders, trigger when price rises to/above target
                const shouldTrigger = order.payload.direction === 'buy'
                    ? marketPrice <= order.payload.targetPrice
                    : marketPrice >= order.payload.targetPrice;

                if (shouldTrigger) {
                    console.log(`[Sui] 🚨 Order ${orderId.slice(0, 10)}... TRIGGERED at $${marketPrice.toFixed(2)}`);

                    // Verify Signature
                    if (order.payload.signature) {
                        const isValid = verifySignature(order.payload);
                        if (!isValid) {
                            console.error(`[Sui] ❌ Signature verification failed for order ${orderId}`);
                            // Mark as processed/failed to avoid retry loop
                            order.processed = true;
                            suiOrders.set(orderId, order);
                            saveState();
                            continue;
                        }
                        console.log(`[Sui] ✍️ Signature verified for ${order.payload.userEthAddress.slice(0, 8)}...`);
                    } else {
                        console.warn(`[Sui] ⚠️ No signature found for order ${orderId}. Executing anyway (Legacy/Dev).`);
                    }

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

                    const txHash = await executeSettlement(mockStrategy);
                    order.processed = true;
                    suiOrders.set(orderId, order);
                    saveState(); // Remove from pending orders
                    console.log(`[Sui] ✅ Order ${orderId.slice(0, 10)}... executed`);

                    // Broadcast execution result to all connected frontends
                    if (wss && wss.clients && txHash) {
                        const execMsg = JSON.stringify({
                            type: "ORDER_EXECUTED",
                            orderId,
                            txHash,
                            direction: order.payload.direction,
                            amount: order.payload.amount,
                            targetPrice: order.payload.targetPrice,
                            executedAt: marketPrice,
                        });
                        wss.clients.forEach(client => {
                            if (client.readyState === 1) client.send(execMsg);
                        });
                    }
                }
            }

            // Check Dynamic Orders (Yellow Network Dev Mode)
            for (const [orderId, dynOrder] of dynamicOrders) {
                if (dynOrder.status !== 'active') continue;

                // Update trailing target
                // Initialize extreme price if not set
                if (dynOrder.extremePrice === undefined) {
                    dynOrder.extremePrice = marketPrice;
                }

                let shouldTrigger = false;

                if (dynOrder.direction === 'buy') {
                    // TRAILING LIMIT BUY: Buy the dip
                    // Target = Highest Price - Offset
                    // Logic: If price rises, target follows UP. If price drops, target stays (gap closes).

                    // 1. Update highest price seen
                    if (marketPrice > dynOrder.extremePrice) {
                        dynOrder.extremePrice = marketPrice;
                    }

                    // 2. Calculated Target = Highest - Offset
                    dynOrder.currentTarget = dynOrder.extremePrice - dynOrder.trailingOffset;



                    // 3. Check trigger (Price drops to hit target)
                    if (marketPrice <= dynOrder.currentTarget) {
                        shouldTrigger = true;
                    }
                } else {
                    // TRAILING LIMIT SELL: Sell the rip
                    // Target = Lowest Price + Offset
                    // Logic: If price drops, target follows DOWN. If price rises, target stays (gap closes).

                    // 1. Update lowest price seen
                    if (marketPrice < dynOrder.extremePrice) {
                        dynOrder.extremePrice = marketPrice;
                    }

                    // 2. Calculated Target = Lowest + Offset
                    dynOrder.currentTarget = dynOrder.extremePrice + dynOrder.trailingOffset;

                    // 3. Check trigger (Price rises to hit target)
                    if (marketPrice >= dynOrder.currentTarget) {
                        shouldTrigger = true;
                    }
                }

                if (shouldTrigger) {
                    console.log(`[Yellow] 🎯 Dynamic order ${orderId.slice(0, 12)} TRIGGERED at $${marketPrice.toFixed(2)} (Target: $${dynOrder.currentTarget.toFixed(2)})`);
                    dynOrder.status = 'triggered';

                    // Execute on Ethereum
                    const mockStrategy: StrategyPayload = {
                        intent: 'DYNAMIC_ORDER',
                        price: dynOrder.currentTarget,
                        nonce: Date.now(),
                        user: dynOrder.userAddress,
                        sessionSigner: dynOrder.userAddress,
                        signature: '',
                        amount: dynOrder.amount,
                        direction: dynOrder.direction,
                    };

                    try {
                        const txHash = await executeSettlement(mockStrategy);
                        dynOrder.status = 'executed';
                        console.log(`[Yellow] ✅ Dynamic order ${orderId.slice(0, 12)} executed: ${txHash}`);

                        // Notify the client
                        if (dynOrder.ws.readyState === 1) {
                            dynOrder.ws.send(JSON.stringify({
                                type: "DYNAMIC_ORDER_EXECUTED",
                                orderId,
                                txHash,
                                executedAt: marketPrice,
                            }));
                        }

                        // Remove from active orders
                        dynamicOrders.delete(orderId);
                    } catch (execErr) {
                        console.error(`[Yellow] Execution failed:`, execErr);
                        dynOrder.status = 'failed';

                        // Notify client of failure
                        if (dynOrder.ws.readyState === 1) {
                            dynOrder.ws.send(JSON.stringify({
                                type: "DYNAMIC_ORDER_FAILED",
                                orderId,
                                error: (execErr as Error).message
                            }));
                        }

                        // Remove from map to prevent memory leak since it's failed
                        dynamicOrders.delete(orderId);
                    }
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
async function executeSettlement(strategy: StrategyPayload): Promise<string | null> {
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

        // Dynamic Amount Logic
        // Token0 = vUSDC, Token1 = vETH
        let zeroForOne = true;
        let amountSpecified = -1_000_000n; // Default

        if (strategy.direction === 'sell') {
            // SELL ETH for USDC
            // Token1 (ETH) -> Token0 (USDC)
            // zeroForOne = false
            zeroForOne = false;

            // Amount is in USDC (from UI). So we want Exact Output of USDC.
            // Positive amountSpecified = Exact Output of Token0 (USDC)
            if (strategy.amount) {
                amountSpecified = BigInt(Math.floor(strategy.amount * 1_000_000));
            }
        } else {
            // BUY ETH with USDC
            // Token0 (USDC) -> Token1 (ETH)
            // zeroForOne = true
            zeroForOne = true;

            // Amount is in USDC. We spend Exact Input of USDC.
            // Negative amountSpecified = Exact Input of Token0 (USDC)
            if (strategy.amount) {
                amountSpecified = -BigInt(Math.floor(strategy.amount * 1_000_000));
            }
        }

        console.log(`[Agent] Executing ${strategy.direction?.toUpperCase()} swap: ${amountSpecified > 0 ? 'Receive' : 'Spend'} ${Math.abs(Number(amountSpecified))} units`);

        const swapParams = {
            zeroForOne,
            amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO : MAX_SQRT_RATIO
        };

        const tx = await veiledContract.settle(
            key,
            swapParams,
            strategy.user
        );

        console.log(`[Agent] Transaction Sent! Hash: ${tx.hash}`);
        console.log(`[Agent] Execution confirmed.`);
        return tx.hash;
    } catch (e) {
        console.error(`[Agent] Execution Failed: ${(e as Error).message}`);
        return null;
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

        // Debug logging disabled for cleaner output
        // console.log(`[DEBUG] sqrtPriceX96=${sqrtPriceX96}, rawPrice=${rawPrice}, price=${price}`);

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

        // Token0 = vUSDC, Token1 = vETH
        // zeroForOne = true: USDC → ETH = BUY ETH
        // zeroForOne = false: ETH → USDC = SELL ETH

        const isBuy = direction === 'buy';

        // V4 Params:
        // amountSpecified < 0: Exact Input (Spending X)
        // amountSpecified > 0: Exact Output (Receiving X)

        let amountSpecified: bigint;

        // Valid price limits for swaps
        const MIN_SQRT_RATIO = 4295128739n + 1n;
        const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n - 1n;

        if (isBuy) {
            // Buying ETH with USDC: "Buy 100" -> Spend 100 USDC (Exact Input, 6 decimals)
            const usdc = BigInt(Math.floor(amount * 1_000_000));
            amountSpecified = -usdc; // Negative = Exact Input
        } else {
            // Selling ETH for USDC: "Sell 1" -> Spend 1 ETH (Exact Input, 18 decimals)
            const wei = ethers.parseEther(amount.toString());
            amountSpecified = -wei; // Negative = Exact Input
        }

        const swapParams = {
            zeroForOne: isBuy, // true = USDC→ETH (buy), false = ETH→USDC (sell)
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: isBuy ? MIN_SQRT_RATIO : MAX_SQRT_RATIO
        };

        console.log(`[Swap] ${direction}: zeroForOne=${swapParams.zeroForOne}, amount=${amountSpecified}`);

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
    await manualSwap('sell', "0.01");
}

async function placeOrder(_priceStr: string) {
    console.log("Place order via the app: encrypt → Walrus → create order on Sui. Agent picks up orders from Sui and decrypts blob.");
}

// ---------------------------------------------------------
// 7. Sui Order Polling (Encrypted Orders from Walrus)
// ---------------------------------------------------------
async function pollSuiOrders() {
    if (!suiClient) {
        await initSuiClient();
    }

    try {
        // Query OrderCreated events - use cursor to only get NEW events
        const queryParams: any = {
            query: {
                MoveEventType: `${SUI_PACKAGE_ID}::order::OrderCreated`,
            },
            limit: 50,
            order: 'ascending', // Get oldest first so we process in order
        };

        // If we have a cursor, only fetch events AFTER it
        if (agentState.cursor) {
            queryParams.cursor = agentState.cursor;
        }

        const events = await suiClient.queryEvents(queryParams);

        if (events.data.length === 0) {
            return; // No new events
        }

        console.log(`[Sui] Found ${events.data.length} new event(s)`);

        for (const event of events.data) {
            const orderId = (event.parsedJson as any).order_id;

            // Skip if already in memory (shouldn't happen with cursor, but just in case)
            if (suiOrders.has(orderId)) {
                continue;
            }

            // Get blob ID from event
            const blobIdBytes = (event.parsedJson as any).blob_id as number[];
            const blobId = new TextDecoder().decode(new Uint8Array(blobIdBytes));

            console.log(`[Sui] 📦 New order found: ${orderId.slice(0, 10)}... blob: ${blobId.slice(0, 20)}...`);

            // Fetch encrypted blob from Walrus and decrypt with Seal
            try {
                const payload = await decryptOrderWithSeal(orderId, blobId);

                if (!payload) {
                    console.warn(`[Sui] Failed to decrypt order ${orderId.slice(0, 10)}...`);
                    continue;
                }

                console.log(`[Seal] 🔓 Decrypted order: ${payload.direction} ${payload.amount} USDC at $${payload.targetPrice}`);

                // Store order for price checking
                suiOrders.set(orderId, {
                    orderId,
                    blobId,
                    payload,
                    processed: false,
                });

                // Notify frontend that order is decrypted and waiting for trigger
                if (wss && wss.clients) {
                    const pendingMsg = JSON.stringify({
                        type: "ORDER_PENDING",
                        orderId,
                        direction: payload.direction,
                        amount: payload.amount,
                        targetPrice: payload.targetPrice,
                    });
                    wss.clients.forEach((client: any) => {
                        if (client.readyState === 1) client.send(pendingMsg);
                    });
                }

            } catch (e) {
                console.warn(`[Sui] Failed to process blob: ${e}`);
                // Still continue to next event
            }

            // Update cursor after processing each event
            agentState.cursor = event.id;
            agentState.processedCount++;
            saveState();
        }

        // If there's a next page, store the next cursor
        if (events.nextCursor) {
            agentState.cursor = events.nextCursor;
            saveState();
        }

    } catch (e) {
        console.error("[Sui] Polling error:", e);
    }
}

// ---------------------------------------------------------
// Seal Decryption: Decrypt order blob using Seal SDK
// ---------------------------------------------------------
async function decryptOrderWithSeal(orderId: string, blobId: string): Promise<SuiOrderPayload | null> {
    const { Transaction } = await getSuiTransaction();
    const { SessionKey } = await getSealModule();

    // 1. Fetch encrypted blob from Walrus
    console.log(`[Seal] Fetching encrypted blob from Walrus...`);
    const response = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch blob: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const encryptedData = new Uint8Array(buffer);
    console.log(`[Seal] Fetched ${encryptedData.length} bytes`);

    // 2. Create a session key for this decryption request
    // SessionKey is bound to agent's address and the package ID
    const agentAddress = suiSigner.getPublicKey().toSuiAddress();
    console.log(`[Seal] Creating session key for ${agentAddress.slice(0, 16)}...`);

    const sessionKey = await SessionKey.create({
        address: agentAddress,
        packageId: SUI_PACKAGE_ID,
        ttlMin: 10, // 10 minute TTL
        signer: suiSigner,
        suiClient: suiClient,
    });
    console.log(`[Seal] Session key created`);

    // 3. Extract the Seal ID from the encrypted object header
    // The ID is embedded during encryption and needed for building the approval tx
    const { EncryptedObject } = await getSealModule();
    let encryptedObj;
    try {
        encryptedObj = EncryptedObject.parse(encryptedData);
    } catch (parseErr) {
        console.error(`[Seal] Failed to parse encrypted object - likely old/incompatible format:`, parseErr);
        return null;
    }

    // The ID is returned as a hex string by the Seal SDK (via BCS transform)
    // We need to convert it back to bytes for the Move function
    const idHex = encryptedObj.id as string;
    if (!idHex || idHex.length === 0) {
        console.error(`[Seal] Empty Seal ID - this order may have been encrypted with an old/different package`);
        return null;
    }

    // Convert hex string to bytes (without 0x prefix if present)
    const cleanHex = idHex.startsWith('0x') ? idHex.slice(2) : idHex;
    const idBytes = Buffer.from(cleanHex, 'hex');
    console.log(`[Seal] Extracted Seal ID: ${cleanHex.slice(0, 32)}... (${idBytes.length} bytes)`);

    // 4. Build transaction that calls seal_approve_order
    const tx = new Transaction();
    tx.moveCall({
        target: `${SUI_PACKAGE_ID}::order::seal_approve_order`,
        arguments: [
            tx.pure.vector('u8', Array.from(idBytes)),
            tx.object(orderId), // The Order object ID
        ],
    });
    tx.setSender(agentAddress);

    // Build transaction for Seal key server simulation
    // IMPORTANT: onlyTransactionKind: true returns just the PTB commands, which Seal expects
    const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
    console.log(`[Seal] Built approval tx: ${txBytes.length} bytes`);

    // 5. Decrypt using Seal SDK
    console.log(`[Seal] Calling Seal key servers for decryption...`);
    try {
        const decrypted = await sealClient.decrypt({
            data: encryptedData,
            sessionKey,
            txBytes,
        });

        // 6. Parse decrypted payload
        const payloadText = new TextDecoder().decode(decrypted);
        const payload = JSON.parse(payloadText) as SuiOrderPayload;

        return payload;
    } catch (e) {
        console.error(`[Seal] Decryption failed:`, e);
        return null;
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

    console.log(`[Agent] 🤖 Agent Active (ETH): ${wallet.address}`);

    veiledContract = new ethers.Contract(VEILED_ADDRESS, HOOK_ABI, wallet);
    poolManager = new ethers.Contract(POOL_MANAGER_ADDR, POOL_MANAGER_ABI, provider);

    poolKey = {
        currency0: TOKEN0_ADDR,
        currency1: TOKEN1_ADDR,
        fee: 3000,
        tickSpacing: 60,
        hooks: VEILED_ADDRESS
    };

    // Initialize Sui client and signer
    await initSuiClient();

    // Load pending orders from previous session
    if (agentState.pendingOrders.length > 0) {
        for (const order of agentState.pendingOrders) {
            suiOrders.set(order.orderId, {
                orderId: order.orderId,
                blobId: order.blobId,
                payload: order.payload,
                processed: false,
            });
        }
        console.log(`[Agent] 📋 Restored ${agentState.pendingOrders.length} pending order(s):`);
        for (const order of agentState.pendingOrders) {
            console.log(`  → ${order.payload.direction.toUpperCase()} ${order.payload.amount} USDC @ $${order.payload.targetPrice}`);
        }
    }

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
