"use client";

import { useEffect, useRef, useState } from "react";
import { Zap } from "lucide-react";

interface SliderProps {
    onLog: (msg: string) => void;
}

export default function Slider({ onLog }: SliderProps) {
    const [price, setPrice] = useState(2400);
    const ws = useRef<WebSocket | null>(null);
    const lastLogTime = useRef(0);

    // Connect to WebSocket on mount
    useEffect(() => {
        const connect = () => {
            // Mock WebSocket Connection to Agent
            // Note: In a real app, this would point to the running agent service.
            // We use localhost:8080 as per instructions.
            const socket = new WebSocket("ws://localhost:8080");

            socket.onopen = () => {
                onLog("[Yellow] Connected to High-Frequency Stream Layer.");
            };

            socket.onerror = (err) => {
                console.error("WS Error", err);
                // Silent fail for UX or log only once
            };

            socket.onclose = () => {
                // onLog("[Yellow] Stream Disconnected. Retrying...");
                // Simple reconnect logic could go here
            };

            ws.current = socket;
        };

        connect();

        return () => {
            ws.current?.close();
        };
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newPrice = parseInt(e.target.value);
        setPrice(newPrice);

        const payload = {
            intent: "BUY",
            price: newPrice,
            nonce: Date.now()
        };

        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify(payload));

            // Throttle logs to avoid spamming the console visually
            if (Date.now() - lastLogTime.current > 500) {
                onLog(`⚡ [Yellow] Streamed Update: $${newPrice}`);
                lastLogTime.current = Date.now();
            }
        }
    };

    return (
        <div className="flex flex-col gap-4 h-full justify-center">

            <div className="flex justify-between items-center px-2">
                <span className="text-[#bd00ff] font-bold text-xl flex items-center gap-2">
                    <Zap className="fill-current animate-pulse" /> HIGH-FREQ
                </span>
                <span className="text-2xl font-mono text-white cyber-glow-text">
                    ${price}
                </span>
            </div>

            <div className="relative h-12 w-full flex items-center">
                {/* Track */}
                <div className="absolute w-full h-2 bg-purple-900/50 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-[#bd00ff] transition-all duration-75"
                        style={{ width: `${((price - 2000) / 1000) * 100}%` }}
                    ></div>
                </div>

                {/* Slider Input */}
                <input
                    type="range"
                    min="2000"
                    max="3000"
                    step="1"
                    value={price}
                    onChange={handleChange}
                    className="w-full h-full opacity-0 cursor-crosshair absolute z-10"
                />

                {/* Custom Thumb Visual (follows value) */}
                <div
                    className="absolute h-8 w-4 bg-white border-2 border-[#bd00ff] shadow-[0_0_15px_#bd00ff] pointer-events-none transition-all duration-75"
                    style={{ left: `calc(${((price - 2000) / 1000) * 100}% - 8px)` }}
                ></div>
            </div>

            <div className="flex justify-between text-xs text-gray-500 font-mono">
                <span>$2000</span>
                <span>LIQUIDITY STREAM</span>
                <span>$3000</span>
            </div>
        </div>
    );
}
