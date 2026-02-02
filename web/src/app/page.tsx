"use client";

import { useState, useRef, useEffect } from "react";
import { Terminal, Lock, Activity, UploadCloud, ShieldCheck } from "lucide-react";
import { uploadToWalrus } from "./walrusService";

export default function Home() {
  const [logs, setLogs] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleBuy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !price) return;

    setIsProcessing(true);
    addLog("Initiating Limit Order...");

    try {
      const orderData = JSON.stringify({
        type: "BUY_ETH",
        amount,
        price,
        nonce: Date.now(),
        timestamp: new Date().toISOString()
      });

      // Use Walrus Service
      const blobId = await uploadToWalrus(orderData, addLog);

      addLog("SUCCESS: Order stored decentralized.");
      addLog(`Reference Blob ID: ${blobId}`);

    } catch (error) {
      addLog(`ERROR: ${(error as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col p-4 relative overflow-hidden">
      {/* Visual Effects */}
      <div className="scanline"></div>

      {/* Header */}
      <header className="flex items-center justify-between border-b border-green-900 pb-4 mb-6">
        <div className="flex items-center gap-2">
          <Terminal className="text-[#00ff41]" />
          <h1 className="text-2xl font-bold tracking-widest text-[#00ff41] cyber-glow-text">VEILED PROTOCOL</h1>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> NET: TESTNET</span>
          <span>V: 0.1.0-ALPHA</span>
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 relative z-20">

        {/* Left Panel: Static Orders */}
        <section className="cyber-border bg-[#050505] p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2 mb-2 border-b border-gray-800 pb-2">
            <Lock size={18} className="text-[#00ff41]" />
            <h2 className="text-lg font-bold text-[#00ff41]">STATIC ORDERS</h2>
          </div>

          <p className="text-xs text-gray-400 mb-4">
            Orders are encrypted client-side and stored on Walrus (Sui).
            Ghost Agents execute them when conditions are met.
          </p>

          <form onSubmit={handleBuy} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">ASSET PAIR</label>
              <div className="flex gap-2">
                <select className="bg-black border border-[#333] text-[#00ff41] p-2 flex-1 outline-none focus:border-[#00ff41]">
                  <option>USDC / ETH</option>
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">AMOUNT (USDC)</label>
              <input
                type="number"
                placeholder="1000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="bg-black/50"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">TRIGGER PRICE (Limit)</label>
              <input
                type="number"
                placeholder="2400.00"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="bg-black/50"
              />
            </div>

            <button
              disabled={isProcessing}
              className="cyber-btn mt-4 py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? (
                <>UPLOADING <UploadCloud className="animate-bounce" size={16} /></>
              ) : (
                <>ENCRYPT & SIGN <ShieldCheck size={16} /></>
              )}
            </button>
          </form>

          {/* Agent Status Mock */}
          <div className="mt-auto border-t border-gray-800 pt-4">
            <div className="text-xs text-gray-500 mb-2">ACTIVE GHOST AGENTS</div>
            <div className="flex gap-2">
              <div className="bg-green-900/20 text-green-400 px-2 py-1 text-xs border border-green-900 rounded">
                AGENT-01 (IDLE)
              </div>
              <div className="bg-green-900/20 text-green-400 px-2 py-1 text-xs border border-green-900 rounded">
                AGENT-02 (LISTENING)
              </div>
            </div>
          </div>
        </section>

        {/* Right Panel: Dynamic Stream (Placeholder) */}
        <section className="cyber-border-purple bg-[#050505] p-6 flex flex-col relative overflow-hidden">
          <div className="flex items-center gap-2 mb-2 border-b border-gray-800 pb-2">
            <Activity size={18} className="text-[#bd00ff]" />
            <h2 className="text-lg font-bold text-[#bd00ff]">DYNAMIC STREAM</h2>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50">
            <div className="w-16 h-16 border-2 border-dashed border-[#bd00ff] rounded-full flex items-center justify-center mb-4 animate-[spin_10s_linear_infinite]">
              <div className="w-10 h-10 bg-[#bd00ff]/20 rounded-full"></div>
            </div>
            <h3 className="text-[#bd00ff] font-bold">YELLOW NETWORK SLIDER</h3>
            <p className="text-xs text-gray-500 mt-2 max-w-[200px]">
              Coming Soon: High-speed cross-chain liquidity stream visualization.
            </p>
          </div>

          {/* Mock Graph aesthetics */}
          <div className="absolute bottom-0 left-0 right-0 h-32 opacity-20 pointer-events-none">
            {/* Just some CSS lines */}
            <div className="w-full h-full" style={{
              background: 'repeating-linear-gradient(45deg, transparent, transparent 10px, #bd00ff 10px, #bd00ff 11px)'
            }}></div>
          </div>
        </section>

      </main>

      {/* Logs Console */}
      <footer className="mt-6 h-48 border-t-2 border-[#333] bg-black/80 font-mono text-xs p-4 flex flex-col">
        <div className="text-gray-500 mb-2 font-bold flex justify-between">
          <span>&gt; SYSTEM_LOGS</span>
          <span className="text-green-500 animate-pulse">● LIVE</span>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1 text-[#00ff41]">
          <div className="opacity-50">[SYSTEM] Connection established to Walrus Testnet.</div>
          <div className="opacity-50">[SYSTEM] Veiled Protocol Dashboard v0.1 initialized.</div>
          {logs.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
          <div className="animate-pulse">_</div>
        </div>
      </footer>
    </div>
  );
}
