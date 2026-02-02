"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Square, Activity, Wifi } from "lucide-react";
import { getOrCreateSession, signWithSession } from "../utils/sessionKey";

interface StrategyProps {
    onLog: (msg: string) => void;
}

export default function Strategy({ onLog }: StrategyProps) {
    const [isRunning, setIsRunning] = useState(false);
    const [offset, setOffset] = useState(50);
    const [marketPrice, setMarketPrice] = useState(0);
    const [sessionStatus, setSessionStatus] = useState("No Session");

    // Refs for Loop
    const ws = useRef<WebSocket | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const sessionRef = useRef<any>(null);

    // 1. Initialize Session & WS
    useEffect(() => {
        // Init Session
        const session = getOrCreateSession();
        sessionRef.current = session;
        setSessionStatus(`Session Active (${session.address.slice(0, 6)}...)`);

        // Connect WS
        const socket = new WebSocket("ws://localhost:8080");
        ws.current = socket;

        return () => {
            socket.close();
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, []);

    // 2. Fetch Market Price (Mock/Real)
    const fetchPrice = async () => {
        try {
            // Use CoinGecko or fallback mock
            const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
            const data = await res.json();
            return data.ethereum?.usd || 2400; // Fallback
        } catch (e) {
            return 2400 + Math.random() * 10; // Mock variance
        }
    };

    // 3. The Strategy Loop
    useEffect(() => {
        if (!isRunning) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            return;
        }

        const runLoop = async () => {
            const currentPrice = await fetchPrice();
            setMarketPrice(currentPrice);

            const targetPrice = currentPrice - offset;

            // Prepare Payload
            const payload = {
                intent: "STRATEGY_UPDATE",
                price: Number(targetPrice.toFixed(2)),
                nonce: Date.now(),
                user: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Mock Main User
                sessionSigner: sessionRef.current.address
            };

            // Sign with Session Key
            const signature = await signWithSession(sessionRef.current, payload);
            const message = { ...payload, signature };

            // Broadcast
            if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                ws.current.send(JSON.stringify(message));
                onLog(`⚡ [Strat] Broadcast Target: $${targetPrice.toFixed(2)} (Signed by Session)`);
            }
        };

        const id = setInterval(runLoop, 2000); // 2 Second Loop
        intervalRef.current = id;

        return () => clearInterval(id);
    }, [isRunning, offset, onLog]);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center px-0 border-b border-purple-900/30 pb-2">
                <span className="text-[#bd00ff] font-bold text-lg flex items-center gap-2">
                    <Activity className="animate-pulse" size={18} /> GHOST STRATEGY
                </span>
                <span className="text-xs text-gray-500 flex items-center gap-1">
                    <Wifi size={12} className={ws.current?.readyState === 1 ? "text-green-500" : "text-red-500"} />
                    {sessionStatus}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-gray-500 uppercase">Live ETH Price</label>
                    <div className="text-xl font-mono text-white">
                        ${marketPrice ? marketPrice.toFixed(2) : "---"}
                    </div>
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-gray-500 uppercase">Target (Trailing)</label>
                    <div className="text-xl font-mono text-[#bd00ff]">
                        ${marketPrice ? (marketPrice - offset).toFixed(2) : "---"}
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-2 bg-black/40 p-3 rounded border border-purple-900/30">
                <label className="text-xs text-purple-400">TRAILING OFFSET ($)</label>
                <div className="flex items-center gap-2">
                    <input
                        type="number"
                        value={offset}
                        onChange={(e) => setOffset(Number(e.target.value))}
                        className="bg-black border border-purple-900 w-20 p-1 text-center text-white outline-none focus:border-[#bd00ff]"
                    />
                    <span className="text-xs text-gray-500">below market</span>
                </div>
            </div>

            <button
                onClick={() => setIsRunning(!isRunning)}
                className={`flex items-center justify-center gap-2 py-3 font-bold uppercase transition-all ${isRunning
                    ? "bg-red-900/50 text-red-500 border border-red-900 hover:bg-red-900/80"
                    : "bg-[#bd00ff] text-black hover:shadow-[0_0_15px_#bd00ff]"
                    }`}
            >
                {isRunning ? (
                    <> <Square size={16} fill="currentColor" /> STOP ENGINE </>
                ) : (
                    <> <Play size={16} fill="currentColor" /> START ENGINE </>
                )}
            </button>
        </div>
    );
}
