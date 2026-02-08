"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Lock, Activity, UploadCloud, ShieldCheck, Wallet, Zap } from "lucide-react";
import DynamicOrder from "../components/slider";
import { useAccount, useSignTypedData } from "wagmi";
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { encryptOrder, type OrderPayload } from "../utils/sui-order";

export default function Home() {
  const [logs, setLogs] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Wagmi for ETH address and signing
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  // WebSocket for price feed and order submission
  const ws = useRef<WebSocket | null>(null);
  useEffect(() => {
    const socket = new WebSocket("ws://localhost:8080");
    ws.current = socket;
    socket.onopen = () => addLog("System Connected to Agent Net.");

    // Handle responses from agent
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "PRICE_UPDATE") {
          setMarketPrice(data.price);
        } else if (data.type === "ORDER_CREATED") {
          addLog(`✅ Order created on Sui (tx: ${data.digest || data.txDigest || 'pending'})`);
          addLog(`📦 Walrus Blob: ${data.blobId}`);
          addLog(`🔗 https://aggregator.walrus-testnet.walrus.space/v1/blobs/${data.blobId}`);
        } else if (data.type === "ORDER_PENDING") {
          // Order decrypted by agent, waiting for price trigger
          addLog(`🔓 Order decrypted by Agent`);
          addLog(`⏳ Waiting for ${data.direction?.toUpperCase()} trigger: $${data.targetPrice} (${data.amount} USDC)`);
        } else if (data.type === "ORDER_ERROR") {
          addLog(`❌ Order failed: ${data.error}`);
        } else if (data.type === "ORDER_EXECUTED") {
          // Order was executed on Ethereum!
          addLog(`🎉 ORDER EXECUTED SUCCESSFULLY!`);
          addLog(`💰 ${data.direction?.toUpperCase()} ${data.amount} USDC @ $${data.executedAt?.toFixed(2)}`);
          addLog(`🔗 https://sepolia.etherscan.io/tx/${data.txHash}`);
        }
      } catch {
        // Ignore non-JSON messages (price updates)
      }
    };

    return () => { socket.close(); };
  }, []);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

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

    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      addLog("ERROR: Not connected to Agent. Refresh the page.");
      return;
    }

    setIsProcessing(true);
    addLog("Initiating Secure Limit Order...");
    console.log("[Order] Place Order: Sign → Encrypt → Send to Agent → Agent uploads to Walrus & creates Sui order.");

    try {
      const targetPrice = Number(price);
      const amountVal = Number(amount);

      // 1. Sign Order (EIP-712)
      addLog("Requesting Signature...");
      const signature = await signTypedDataAsync({
        domain: {
          name: 'Veiled Protocol',
          version: '1',
          chainId: 11155111, // Sepolia
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: {
          Order: [
            { name: 'targetPrice', type: 'uint256' },
            { name: 'amount', type: 'uint256' },
            { name: 'direction', type: 'string' },
            { name: 'userEthAddress', type: 'address' },
          ],
        },
        primaryType: 'Order',
        message: {
          targetPrice: BigInt(Math.floor(targetPrice)),
          amount: BigInt(Math.floor(amountVal * 1_000_000)), // Convert to micro-USDC (6 decimals)
          direction: 'buy',
          userEthAddress: address,
        },
      });
      addLog("✅ Order Signed.");

      // 2. Encrypt order locally
      const orderPayload: OrderPayload = {
        targetPrice,
        amount: amountVal,
        direction: "buy",
        userEthAddress: address,
        signature,
      };
      addLog("Encrypting order...");
      const encryptedData = await encryptOrder(orderPayload);
      addLog(`Order encrypted (${encryptedData.length} bytes).`);

      // 3. Send encrypted order to agent via WebSocket
      // Agent will: upload to Walrus → create order on Sui with agent's key
      addLog("Sending to Agent for Walrus upload & Sui order creation...");
      const message = JSON.stringify({
        type: "CREATE_ORDER",
        encryptedPayload: Array.from(encryptedData), // Send as array for JSON
      });
      ws.current.send(message);

      addLog("Order submitted to Agent. Waiting for confirmation...");
      console.log("[Order] Sent encrypted order to agent:", encryptedData.length, "bytes");
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
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-gray-500 tracking-wider">MARKET PRICE</span>
            <span className="text-xl font-mono text-white tracking-widest">
              ${marketPrice ? marketPrice.toFixed(2) : "---"}
            </span>
          </div>
          <div className="h-8 w-px bg-green-900/50"></div>
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> NET: TESTNET</span>
            {/* Reown Button */}
            <ConnectButton />
          </div>
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

        {/* Right Panel: Dynamic Orders (Yellow Network) */}
        <section className="cyber-border-purple bg-[#050505] p-6 flex flex-col relative overflow-hidden">
          <DynamicOrder onLog={addLog} />
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
