import { ethers } from "ethers";

// --- Configuration ---
const RPC_URL = "http://127.0.0.1:8545"; // Default Anvil/Localhost
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil Account #0 (The Agent)
const VEILED_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // Replace with deployed address

// --- Contract Interface (Minimal ABI for settle) ---
const ABI = [
    "function settle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, tuple(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, address user, bytes signature) external"
];

// --- Types ---
interface Order {
    price: number;
    nonce: number;
    // Additional fields required for settlement would be here in a real app
    // e.g., signature, pool key, swap params, user address
    user: string;
    signature: string;
    key: any; // Simplified for mock
    params: any; // Simplified for mock
}

// --- Memory (RAM) ---
let latestOrder: Order | null = null;

// --- Mock WebSocket / Input ---
async function listenForUpdates() {
    console.log("[Listener] Started listening for signed orders...");

    // Simulate incoming messages at intervals
    setInterval(() => {
        // Mock incoming message
        const mockMsg = {
            price: 2400,
            nonce: Math.floor(Date.now() / 1000), // Increasing nonce
            user: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Anvil Account #1
            signature: "0xMockSignature...",
            key: {
                currency0: "0x...",
                currency1: "0x...",
                fee: 3000,
                tickSpacing: 60,
                hooks: VEILED_ADDRESS
            },
            params: {
                zeroForOne: true,
                amountSpecified: -100n, // Exact input
                sqrtPriceLimitX96: 0n
            }
        };

        if (!latestOrder || mockMsg.nonce > latestOrder.nonce) {
            console.log(`[Listener] New Order Received! Price: ${mockMsg.price}, Nonce: ${mockMsg.nonce}`);
            latestOrder = mockMsg;
        } else {
            console.log(`[Listener] Stale order ignored. (Nonce: ${mockMsg.nonce})`);
        }
    }, 5000); // New order every 5 seconds
}

// --- Market Watch Logic ---
async function checkMarketAndExecute(contract: ethers.Contract) {
    console.log("[MarketWatch] Started monitoring market...");

    // Mock Market Price updates
    setInterval(async () => {
        // Simulate fluctuating market price
        const marketPrice = 2390 + Math.random() * 20; // Random between 2390 and 2410
        console.log(`[MarketWatch] Current Market Price: ${marketPrice.toFixed(2)}`);

        if (latestOrder) {
            console.log(`[MarketWatch] Checking trigger: ${marketPrice.toFixed(2)} <= ${latestOrder.price}?`);

            if (marketPrice <= latestOrder.price) {
                console.log("[MarketWatch] Condition Met! Executing Settlement...");
                await executeSettlement(contract, latestOrder);

                // Clear order after execution to prevent double spend (simple logic)
                latestOrder = null;
            }
        }
    }, 2000); // Check every 2 seconds
}

// --- Execution ---
async function executeSettlement(contract: ethers.Contract, order: Order) {
    try {
        console.log(`[Execution] Calling settle() for User: ${order.user}...`);

        // In a real scenario, we would use the actual order.key, order.params, etc.
        // For this mock, we are just calling the function signature.

        // Note: Mocking the transaction since we might not have a running chain or valid signature for the mock
        /* 
        const tx = await contract.settle(
            order.key,
            order.params,
            order.user,
            order.signature
        );
        console.log(`[Execution] Tx Sent: ${tx.hash}`);
        await tx.wait();
        */

        // Simulating successful transaction for the purpose of the task
        await new Promise(r => setTimeout(r, 1000)); // Mock network delay
        console.log(`[Execution] Settlement Confirmed on-chain.`);

        await logArchival();

    } catch (error) {
        console.error("[Execution] Failed:", error);
    }
}

// --- Archival (Sui/Walrus) ---
async function logArchival() {
    console.log("Uploading Proof of Settlement to Walrus...");
    // Walrus SDK implementation will go here in the next step.
}

// --- Main Entry Point ---
async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const veiledContract = new ethers.Contract(VEILED_ADDRESS, ABI, wallet);

    console.log(`Agent Liquidity Manager Initialized. Address: ${wallet.address}`);

    // Start concurrent loops
    listenForUpdates();
    checkMarketAndExecute(veiledContract);
}

// Handle errors
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
