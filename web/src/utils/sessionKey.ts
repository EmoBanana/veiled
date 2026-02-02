import { ethers } from "ethers";

const SESSION_KEY_STORAGE = "veiled_session_key";

// Interface for the Session Data
export interface SessionData {
    privateKey: string;
    address: string;
    expiresAt: number;
}

// 1. Create or Retrieve a Burner Wallet (Session Key)
export function getOrCreateSession(): SessionData {
    if (typeof window === "undefined") {
        // Fallback for SSR
        const wallet = ethers.Wallet.createRandom();
        return { privateKey: wallet.privateKey, address: wallet.address, expiresAt: 0 };
    }

    const stored = localStorage.getItem(SESSION_KEY_STORAGE);
    if (stored) {
        return JSON.parse(stored);
    }

    // Create new
    const wallet = ethers.Wallet.createRandom();
    const session: SessionData = {
        privateKey: wallet.privateKey,
        address: wallet.address,
        expiresAt: Date.now() + 3600 * 1000 // 1 hour
    };

    localStorage.setItem(SESSION_KEY_STORAGE, JSON.stringify(session));
    return session;
}

// 2. Sign a Payload with the Session Key
export async function signWithSession(session: SessionData, payload: any): Promise<string> {
    const wallet = new ethers.Wallet(session.privateKey);
    // Sign the hash of the payload to ensure integrity
    // Simplification: Sign stringified JSON for this demo.
    // In production, sign EIP-712 typed data.
    const signature = await wallet.signMessage(JSON.stringify(payload));
    return signature;
}

// 3. Clear Session
export function clearSession() {
    localStorage.removeItem(SESSION_KEY_STORAGE);
}
