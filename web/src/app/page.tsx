"use client";

import { useState, useRef, useEffect } from "react";
import { Terminal, Lock, Activity, UploadCloud, ShieldCheck, Wallet } from "lucide-react";
import Strategy from "../components/strategy";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { encryptOrderAndUploadToWalrus, type OrderPayload } from "../utils/sui-order";

export default function Home() {
  const [logs, setLogs] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Wagmi Hooks
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  // WebSocket for Orders
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket("ws://localhost:8080");
    ws.current = socket;
    socket.onopen = () => addLog("System Connected to Agent Net.");
    return () => { socket.close(); };
  }, []);

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
    if (!amount || !price || !isConnected || !address) {
      addLog("ERROR: Connect Wallet & Enter Valid Details.");
      return;
    }

    setIsProcessing(true);
    addLog("Initiating Secure Limit Order...");
    console.log("[Order] Place Order: Seal encrypt + Walrus upload + broadcast to agent.");

    try {
      // 1. Encrypt order with Seal and upload to Walrus (before signing broadcast)
      const orderPayload: OrderPayload = {
        targetPrice: Number(price),
        amount: Number(amount),
        direction: "buy",
        userEthAddress: address,
      };
      addLog("Encrypting order with Seal...");
      const blobId = await encryptOrderAndUploadToWalrus(orderPayload);
      addLog(`Order encrypted and uploaded to Walrus (blob: ${blobId.slice(0, 12)}…).`);

      // 2. Build broadcast payload (agent uses this for verification and execution)
      const payload = {
        intent: "STRATEGY_UPDATE",
        price: Number(price),
        amount: Number(amount),
        nonce: Date.now(),
        user: address,
        sessionSigner: address,
        blobId, // so agent can fetch Seal-encrypted blob from Walrus if needed
      };

      // 3. Sign Message (User Wallet)
      addLog("Requesting Signature...");
      const messageToSign = JSON.stringify(payload);
      const signature = await signMessageAsync({ message: messageToSign });
      addLog("Signature Generated.");

      // 4. Send to Agent
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        const fullMessage = { ...payload, signature };
        ws.current.send(JSON.stringify(fullMessage));
        addLog("SUCCESS: Order encrypted (Seal), stored on Walrus, and broadcast to Agent.");
        console.log("[Order] Sent to agent (blobId on Walrus):", blobId);
      } else {
        throw new Error("Agent Disconnected.");
      }
    } catch (error) {
      console.error("[Order] handleBuy error:", error);
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
          {/* Reown Button */}
          <ConnectButton />
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 relative z-20">

        {/* Left Panel: Static Orders */}
        <section className="cyber-border bg-[#050505] p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2 mb-2 border-b border-gray-800 pb-2">
            <Lock size={18} className="text-[#00ff41]" />
            <h2 className="text-lg font-bold text-[#00ff41]">SECURE ORDER ENTRY</h2>
          </div>

          <p className="text-xs text-gray-400 mb-4">
            Orders are signed by your wallet and transmitted directly to the Agent execution layer.
            Wait for the 'Limit' trigger.
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
                className="bg-black/50 text-white p-2 border border-[#333] focus:border-[#00ff41] outline-none"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">TRIGGER PRICE (Limit)</label>
              <input
                type="number"
                placeholder="2400.00"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="bg-black/50 text-white p-2 border border-[#333] focus:border-[#00ff41] outline-none"
              />
            </div>

            <button
              disabled={isProcessing || !isConnected}
              className="cyber-btn mt-4 py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? (
                <>UPLOADING <UploadCloud className="animate-bounce" size={16} /></>
              ) : !isConnected ? (
                <>CONNECT WALLET <Wallet size={16} /></>
              ) : (
                <>SIGN & PLACE ORDER <ShieldCheck size={16} /></>
              )}
            </button>
          </form>

          {/* Agent Status Mock */}
          <div className="mt-auto border-t border-gray-800 pt-4">
            <div className="text-xs text-gray-500 mb-2">ACTIVE GHOST AGENTS</div>
            <div className="flex gap-2">
              <div className="bg-green-900/20 text-green-400 px-2 py-1 text-xs border border-green-900 rounded">
                AGENT-01 (LISTENING)
              </div>
            </div>
          </div>
        </section>

        {/* Right Panel: Dynamic Stream */}
        <section className="cyber-border-purple bg-[#050505] p-6 flex flex-col relative overflow-hidden">

          {/* Strategy Engine Component */}
          <Strategy onLog={addLog} />

          {/* Mock Graph aesthetics */}
          <div className="absolute bottom-0 left-0 right-0 h-32 opacity-20 pointer-events-none -z-10">
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
