"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Zap, Radio, TrendingDown, TrendingUp, Loader2 } from "lucide-react";
import { useAccount, useWalletClient, useSignTypedData } from "wagmi";
import { createAppSessionMessage, parseAnyRPCResponse, type RPCData, RPCProtocolVersion, type RPCAppDefinition, type RPCAppSessionAllocation } from "@erc7824/nitrolite";

// Yellow Network ClearNode endpoints
const CLEARNODE_SANDBOX = "wss://clearnet-sandbox.yellow.com/ws";

// Agent address for state channel (Veiled's clearing counterparty)
const AGENT_ADDRESS = "0x54609ff7660d8bF2F6c2c6078dae2E7f791610b4";

// Development mode - use local agent instead of Yellow Network
const DEV_MODE = true;

interface SliderProps {
    onLog: (msg: string) => void;
}

interface DynamicOrder {
    id: string;
    direction: "buy" | "sell";
    trailingOffset: number;
    amount: number;
    currentTarget: number;
    status: "pending" | "active" | "triggered" | "executed" | "failed";
    createdAt: number;
    extremePrice?: number; // Track extreme price locally for UI
}

export default function Slider({ onLog }: SliderProps) {
    // Wallet connection
    const { address, isConnected } = useAccount();
    const { data: walletClient } = useWalletClient();
    const { signTypedDataAsync } = useSignTypedData();

    // State
    const [trailingOffset, setTrailingOffset] = useState(100); // $ below market
    const [amount, setAmount] = useState<number | string>(500); // USDC amount (allow string for input)
    const [direction, setDirection] = useState<"buy" | "sell">("buy");
    const [marketPrice, setMarketPrice] = useState(0);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [activeOrder, setActiveOrder] = useState<DynamicOrder | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [yellowConnected, setYellowConnected] = useState(false);

    // Use ref for activeOrder to access in WebSocket callbacks without re-triggering effect
    const activeOrderRef = useRef<DynamicOrder | null>(activeOrder);
    useEffect(() => {
        activeOrderRef.current = activeOrder;
    }, [activeOrder]);

    // Refs
    const yellowWs = useRef<WebSocket | null>(null);
    const agentWs = useRef<WebSocket | null>(null);
    const priceRef = useRef(0);

    // Message signer for Yellow Network (handles RPCData or string)
    const messageSigner = useCallback(async (payload: RPCData | string): Promise<`0x${string}`> => {
        if (!walletClient || !address) throw new Error("Wallet not connected");
        const message = typeof payload === "string" ? payload : JSON.stringify(payload);
        return await walletClient.signMessage({
            account: address,
            message,
        });
    }, [walletClient, address]);

    // Update dynamic order target (called on price changes)
    // Ratchet Logic: Only update extreme price in favorable direction
    // Ratchet Logic: Trailing Limit (Buy tracks High, Sell tracks Low)
    const updateDynamicOrderState = (newPrice: number) => {
        const order = activeOrderRef.current;
        if (!order || order.status !== "active") return;

        let updated = false;
        let newExtreme = order.extremePrice ?? newPrice;

        if (order.direction === 'buy') {
            // TRAILING BUY: Tracks Highest Price
            // Target = Highest - Offset
            if (newPrice > newExtreme) {
                newExtreme = newPrice;
                updated = true;
            }
        } else {
            // TRAILING SELL: Tracks Lowest Price
            // Target = Lowest + Offset
            if (newPrice < newExtreme) {
                newExtreme = newPrice;
                updated = true;
            }
        }

        if (updated) {
            const newTarget = order.direction === 'buy'
                ? newExtreme - order.trailingOffset
                : newExtreme + order.trailingOffset;

            setActiveOrder({
                ...order,
                extremePrice: newExtreme,
                currentTarget: newTarget
            });
        }
    };

    // Effect to handle dynamic updates when user changes amount or trailingOffset while order is active
    useEffect(() => {
        const order = activeOrderRef.current;
        if (!order || order.status !== 'active' || !yellowWs.current) return;

        const currentAmount = Number(amount) || 0;

        // Debounce updates to avoid spamming the backend
        const timeoutId = setTimeout(async () => {
            try {
                // Check if parameters actually changed
                if (order.trailingOffset === trailingOffset && order.amount === currentAmount) return;

                // Recalculate target based on CURRENT extreme price (ratchet logic)
                const extreme = order.extremePrice ?? marketPrice;
                const newTarget = order.direction === "buy"
                    ? extreme - trailingOffset
                    : extreme + trailingOffset;

                const updateMessage = {
                    type: "UPDATE_DYNAMIC_ORDER",
                    orderId: order.id,
                    newTarget,
                    newAmount: currentAmount,
                    newTrailingOffset: trailingOffset,
                    marketPrice,
                    timestamp: Date.now(),
                };

                // In dev mode, skip signing for speed
                // const signature = await messageSigner(JSON.stringify(updateMessage));

                yellowWs.current?.send(JSON.stringify({
                    ...updateMessage,
                    // signature,
                }));

                // Update local state
                setActiveOrder({
                    ...order,
                    trailingOffset,
                    amount: currentAmount,
                    currentTarget: newTarget
                });

                // Log update
                onLog(`[Yellow] 🔄 Order Updated: Offset $${trailingOffset}, Target $${newTarget.toFixed(2)}`);

            } catch (err) {
                console.error("Failed to update order params:", err);
            }
        }, 500); // 500ms debounce

        return () => clearTimeout(timeoutId);
    }, [trailingOffset, amount, marketPrice, onLog]); // Re-run when inputs or price change

    // Auto-reset order state after execution
    useEffect(() => {
        if (activeOrder?.status === 'executed') {
            const timer = setTimeout(() => {
                setActiveOrder(null);
                onLog("[Yellow] 🔄 Order fulfilled. Ready for new order.");
            }, 5000); // 5 seconds delay
            return () => clearTimeout(timer);
        }
    }, [activeOrder?.status, onLog]);

    // Connect to Yellow Network ClearNode (or local agent in dev mode)
    useEffect(() => {
        const connectYellow = () => {
            try {
                // In dev mode, use local agent WebSocket for dynamic orders
                const wsUrl = DEV_MODE ? "ws://localhost:8080" : CLEARNODE_SANDBOX;
                const ws = new WebSocket(wsUrl);

                ws.onopen = () => {
                    setYellowConnected(true);
                    if (DEV_MODE) {
                        onLog("[Yellow] ⚡ Dev Mode: Connected to Local Agent");
                    } else {
                        onLog("[Yellow] ⚡ Connected to ClearNode (State Channel)");
                    }
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        // Handle agent messages in dev mode
                        if (DEV_MODE) {
                            if (data.type === "DYNAMIC_ORDER_CREATED") {
                                setSessionId(data.orderId);
                                onLog(`[Yellow] ✅ Dynamic order active`);
                            } else if (data.type === "DYNAMIC_ORDER_TRIGGERED") {
                                onLog(`[Yellow] 🎯 Order triggered at $${data.price}`);
                                if (activeOrderRef.current) {
                                    setActiveOrder({ ...activeOrderRef.current, status: "triggered" });
                                }
                            } else if (data.type === "DYNAMIC_ORDER_EXECUTED") {
                                onLog(`[Yellow] ✅ Executed: ${data.txHash}`);
                                if (activeOrderRef.current) {
                                    setActiveOrder({ ...activeOrderRef.current, status: "executed" });
                                }
                            } else if (data.type === "DYNAMIC_ORDER_FAILED") {
                                onLog(`[Yellow] ❌ Execution Failed: ${data.error}`);
                                if (activeOrderRef.current) {
                                    setActiveOrder({ ...activeOrderRef.current, status: "failed" });
                                }
                            }
                        } else {
                            const message = parseAnyRPCResponse(event.data);
                            handleYellowMessage(message);
                        }
                    } catch {
                        // Ignore non-JSON messages
                    }
                };

                ws.onerror = (err) => {
                    console.error("[Yellow] Connection error:", err);
                    setYellowConnected(false);
                };

                ws.onclose = () => {
                    setYellowConnected(false);
                    // Reconnect after delay
                    setTimeout(connectYellow, 3000);
                };

                yellowWs.current = ws;
            } catch (err) {
                console.error("[Yellow] Failed to connect:", err);
            }
        };

        connectYellow();

        return () => {
            yellowWs.current?.close();
        };
    }, [onLog]); // Removed activeOrder dependency to prevent reconnects

    // Connect to local agent for price feed
    useEffect(() => {
        const socket = new WebSocket("ws://localhost:8080");

        socket.onopen = () => {
            console.log("[Agent] Connected for price feed");
        };

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "PRICE_UPDATE") {
                    setMarketPrice(data.price);
                    priceRef.current = data.price;

                    // Update dynamic order STATE locally (ratchet logic)
                    if (activeOrderRef.current && activeOrderRef.current.status === "active") {
                        updateDynamicOrderState(data.price);
                    }
                }
            } catch {
                // Ignore
            }
        };

        agentWs.current = socket;

        return () => {
            socket.close();
        };
    }, []); // Removed activeOrder dependency

    // Handle Yellow Network messages
    const handleYellowMessage = (message: any) => {
        switch (message.type) {
            case "session_created":
                setSessionId(message.sessionId);
                onLog(`[Yellow] ✅ Session created: ${message.sessionId?.slice(0, 16)}...`);
                break;

            case "state_update":
                onLog(`[Yellow] 📡 State update received`);
                break;

            case "order_matched":
                onLog(`[Yellow] 🎯 Order matched off-chain!`);
                if (activeOrderRef.current) {
                    setActiveOrder({ ...activeOrderRef.current, status: "triggered" });
                }
                break;

            case "settlement_complete":
                onLog(`[Yellow] ✅ Settlement complete: ${message.txHash}`);
                if (activeOrderRef.current) {
                    setActiveOrder({ ...activeOrderRef.current, status: "executed" });
                }
                break;

            case "error":
                onLog(`[Yellow] ❌ Error: ${message.error}`);
                break;

            default:
                console.log("[Yellow] Unknown message:", message);
        }
    };

    // Create app session with agent
    const createSession = async () => {
        if (!yellowWs.current || !isConnected || !address) return;

        try {
            const appDefinition: RPCAppDefinition = {
                application: "veiled-dynamic-order",
                protocol: RPCProtocolVersion.NitroRPC_0_2,
                participants: [address as `0x${string}`, AGENT_ADDRESS as `0x${string}`],
                weights: [50, 50],
                quorum: 100,
                challenge: 86400, // 24h challenge period
                nonce: Date.now(),
            };

            // Initial allocations (amounts in smallest units)
            const allocations: RPCAppSessionAllocation[] = [
                { participant: address as `0x${string}`, asset: "usdc", amount: (Number(amount) * 1_000_000).toString() },
                { participant: AGENT_ADDRESS as `0x${string}`, asset: "usdc", amount: "0" },
            ];

            const sessionMessage = await createAppSessionMessage(
                messageSigner,
                { definition: appDefinition, allocations }
            );

            yellowWs.current.send(sessionMessage);
            onLog("[Yellow] 📤 Session request sent...");
        } catch (err) {
            console.error("[Yellow] Session creation failed:", err);
            onLog(`[Yellow] ❌ Session failed: ${(err as Error).message}`);
        }
    };

    // Create dynamic order
    const createDynamicOrder = async () => {
        if (!isConnected || !address || !yellowConnected) {
            onLog("[Yellow] ❌ Not connected");
            return;
        }

        setIsCreating(true);

        try {
            // Initial Target:
            // Buy: Price + Offset (Stop Buy) or Price - Offset (Limit)?
            // Trailing Stop Buy intended behavior: "Start tracking here. If price drops, follow it down. If price rises X from lowest, buy."
            // So Initial Trigger might be Current + Offset.

            // Wait, standard UI "Trailing Scan".
            // If I Buy with Trailing $100.
            // Current Price $3000.
            // Lowest Seen = $3000.
            // Trigger = $3100.

            const currentTarget = direction === "buy"
                ? marketPrice - trailingOffset
                : marketPrice + trailingOffset;

            const orderAmount = Number(amount) || 0;

            const order: DynamicOrder = {
                id: `dyn-${Date.now()}`,
                direction,
                trailingOffset,
                amount: orderAmount,
                currentTarget,
                status: "active",
                createdAt: Date.now(),
                extremePrice: marketPrice
            };

            if (DEV_MODE) {
                // Sign the order (EIP-712)
                onLog("[Yellow] Requesting Signature...");
                const signature = await signTypedDataAsync({
                    domain: {
                        name: 'Veiled Protocol',
                        version: '1',
                        chainId: 11155111,
                        verifyingContract: '0x0000000000000000000000000000000000000000',
                    },
                    types: {
                        DynamicOrder: [
                            { name: 'direction', type: 'string' },
                            { name: 'trailingOffset', type: 'uint256' },
                            { name: 'amount', type: 'uint256' },
                            { name: 'userAddress', type: 'address' },
                        ],
                    },
                    primaryType: 'DynamicOrder',
                    message: {
                        direction: order.direction,
                        trailingOffset: BigInt(order.trailingOffset),
                        amount: BigInt(Math.floor(orderAmount * 1_000_000)),
                        userAddress: address,
                    },
                });
                onLog("[Yellow] ✅ Order Signed.");

                // Dev mode: send to local agent
                const orderMessage = {
                    type: "CREATE_DYNAMIC_ORDER",
                    order: {
                        id: order.id,
                        direction: order.direction,
                        trailingOffset: order.trailingOffset,
                        amount: order.amount,
                        currentTarget: order.currentTarget,
                        userAddress: address,
                        signature,
                    },
                };
                yellowWs.current?.send(JSON.stringify(orderMessage));
            } else {
                // Production: use Yellow Network state channels
                if (!sessionId) {
                    await createSession();
                }

                const orderMessage = {
                    type: "dynamic_order",
                    order: {
                        id: order.id,
                        direction: order.direction,
                        trailingOffset: order.trailingOffset,
                        amount: order.amount,
                        currentTarget: order.currentTarget,
                        userAddress: address,
                    },
                    timestamp: Date.now(),
                };

                const signature = await messageSigner(JSON.stringify(orderMessage));

                yellowWs.current?.send(JSON.stringify({
                    ...orderMessage,
                    signature,
                }));
            }

            setActiveOrder(order);
            onLog(`[Yellow] ⚡ Trailing ${direction.toUpperCase()} Started`);
            onLog(`[Yellow] 📊 Tracking from $${marketPrice} | Trigger: $${currentTarget.toFixed(2)}`);
        } catch (err) {
            console.error("[Yellow] Order creation failed:", err);
            onLog(`[Yellow] ❌ Failed: ${(err as Error).message}`);
        } finally {
            setIsCreating(false);
        }
    };

    // Cancel active order
    const cancelOrder = async () => {
        // Access from Ref to handle closure issues
        const order = activeOrderRef.current;
        if (!order || !yellowWs.current) return;

        try {
            const cancelMessage = {
                type: "order_cancel",
                orderId: order.id,
                timestamp: Date.now(),
            };

            const signature = await messageSigner(JSON.stringify(cancelMessage));

            yellowWs.current.send(JSON.stringify({
                ...cancelMessage,
                signature,
            }));

            setActiveOrder(null);
            onLog("[Yellow] 🛑 Dynamic order cancelled");
        } catch (err) {
            onLog(`[Yellow] ❌ Cancel failed: ${(err as Error).message}`);
        }
    };

    // Display Logic
    const displayTarget = activeOrder
        ? activeOrder.currentTarget
        : direction === "buy"
            ? marketPrice - trailingOffset
            : marketPrice + trailingOffset;

    return (
        <div className="flex flex-col gap-4 h-full">
            {/* Header */}
            <div className="flex justify-between items-center px-0 border-b border-purple-900/30 pb-2">
                <span className="text-[#bd00ff] font-bold text-lg flex items-center gap-2">
                    <Zap className="fill-current animate-pulse" size={18} /> DYNAMIC ORDER
                </span>
                <span className="text-xs flex items-center gap-1">
                    <Radio size={12} className={yellowConnected ? "text-green-500 animate-pulse" : "text-red-500"} />
                    <span className={yellowConnected ? "text-green-500" : "text-gray-500"}>
                        {yellowConnected ? "YELLOW NET" : "OFFLINE"}
                    </span>
                </span>
            </div>

            {/* Price Display */}
            <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-gray-500 uppercase">Market Price</label>
                    <div className="text-xl font-mono text-white">
                        ${marketPrice ? marketPrice.toFixed(2) : "---"}
                    </div>
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-gray-500 uppercase">
                        Trigger ({direction === "buy" ? "Trailing Buy" : "Trailing Sell"})
                    </label>
                    <div className="text-xl font-mono text-[#bd00ff]">
                        ${marketPrice ? displayTarget.toFixed(2) : "---"}
                    </div>
                </div>
            </div>

            {/* Direction Toggle */}
            <div className="flex gap-2">
                <button
                    onClick={() => setDirection("buy")}
                    disabled={!!activeOrder}
                    className={`flex-1 py-2 text-sm font-bold flex items-center justify-center gap-1 transition-all ${direction === "buy"
                        ? "bg-green-900/50 text-green-400 border border-green-700"
                        : "bg-black/40 text-gray-500 border border-gray-800"
                        } ${activeOrder ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                    <TrendingUp size={14} /> BUY
                </button>
                <button
                    onClick={() => setDirection("sell")}
                    disabled={!!activeOrder}
                    className={`flex-1 py-2 text-sm font-bold flex items-center justify-center gap-1 transition-all ${direction === "sell"
                        ? "bg-red-900/50 text-red-400 border border-red-700"
                        : "bg-black/40 text-gray-500 border border-gray-800"
                        } ${activeOrder ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                    <TrendingDown size={14} /> SELL
                </button>
            </div>

            {/* Trailing Offset Slider */}
            <div className="flex flex-col gap-2 bg-black/40 p-3 rounded border border-purple-900/30">
                <div className="flex justify-between">
                    <label className="text-xs text-purple-400">TRAILING OFFSET</label>
                    <span className="text-xs text-white font-mono">${trailingOffset}</span>
                </div>
                <div className="relative h-8 w-full flex items-center">
                    <div className="absolute w-full h-1 bg-purple-900/50 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-[#bd00ff] transition-all duration-75"
                            style={{ width: `${((trailingOffset - 10) / 490) * 100}%` }}
                        />
                    </div>
                    <input
                        type="range"
                        min="10"
                        max="500"
                        step="10"
                        value={trailingOffset}
                        onChange={(e) => setTrailingOffset(Number(e.target.value))}
                        /* ENABLED even when activeOrder is present to allow dynamic updates */
                        /* disabled={!!activeOrder} */
                        className="w-full h-full opacity-0 cursor-crosshair absolute z-10 disabled:cursor-not-allowed"
                    />
                    <div
                        className="absolute h-6 w-3 bg-white border-2 border-[#bd00ff] shadow-[0_0_10px_#bd00ff] pointer-events-none"
                        style={{ left: `calc(${((trailingOffset - 10) / 490) * 100}% - 6px)` }}
                    />
                </div>
                <div className="flex justify-between text-[10px] text-gray-600 font-mono">
                    <span>$10</span>
                    <span>$500</span>
                </div>
            </div>

            {/* Amount Input */}
            <div className="flex flex-col gap-2 bg-black/40 p-3 rounded border border-purple-900/30">
                <label className="text-xs text-purple-400">AMOUNT (USDC)</label>
                <input
                    type="number"
                    value={amount}
                    onChange={(e) => {
                        const val = e.target.value;
                        setAmount(val === "" ? "" : Number(val));
                    }}
                    /* Also enabled for updates */
                    /* disabled={!!activeOrder} */
                    className="bg-black border border-purple-900 w-full p-2 text-white outline-none focus:border-[#bd00ff] disabled:opacity-50"
                />
            </div>

            {/* Active Order Status */}
            {activeOrder && (
                <div className="bg-purple-900/20 border border-purple-700 p-3 rounded">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-purple-400 uppercase">Active Dynamic Order</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${activeOrder.status === "active" ? "bg-green-900/50 text-green-400" :
                            activeOrder.status === "triggered" ? "bg-yellow-900/50 text-yellow-400" :
                                activeOrder.status === "failed" ? "bg-red-900/50 text-red-400" :
                                    "bg-blue-900/50 text-blue-400"
                            }`}>
                            {activeOrder.status.toUpperCase()}
                        </span>
                    </div>
                    <div className="text-sm font-mono text-white">
                        {activeOrder.direction.toUpperCase()} {activeOrder.amount} USDC
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                        Tracking {activeOrder.direction === 'buy' ? 'Highest' : 'Lowest'}: ${activeOrder.extremePrice?.toFixed(2)} → Trigger: ${activeOrder.currentTarget.toFixed(2)}
                    </div>
                </div>
            )}


            {/* Action Button */}
            {
                !activeOrder ? (
                    <button
                        onClick={createDynamicOrder}
                        disabled={!isConnected || !yellowConnected || isCreating || marketPrice === 0}
                        className="flex items-center justify-center gap-2 py-3 font-bold uppercase bg-[#bd00ff] text-black hover:shadow-[0_0_15px_#bd00ff] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isCreating ? (
                            <><Loader2 size={16} className="animate-spin" /> CREATING...</>
                        ) : !isConnected ? (
                            <>CONNECT WALLET</>
                        ) : (
                            <><Zap size={16} /> CREATE DYNAMIC ORDER</>
                        )}
                    </button>
                ) : (
                    <button
                        onClick={cancelOrder}
                        className="flex items-center justify-center gap-2 py-3 font-bold uppercase bg-red-900/50 text-red-500 border border-red-900 hover:bg-red-900/80 transition-all"
                    >
                        CANCEL ORDER
                    </button>
                )
            }

            {/* Info */}
            <div className="text-[10px] text-gray-600 text-center mt-auto">
                Powered by Yellow Network State Channels • Gas-Free Off-Chain Execution
            </div>
        </div >
    );
}
