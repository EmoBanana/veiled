/**
 * Seal Encryption + Walrus Storage Utilities
 * Handles encrypted order creation for Veiled Protocol on Sui
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl, SuiEvent } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SealClient } from '@mysten/seal';

// Sui Testnet Package ID (deployed 2026-02-08)
const SUI_PACKAGE_ID = '0xa0418d4c65c9ff236ec7bb8f650d88ddab6ee42cf31ce41f288e493dcf3df29e';

// Walrus Testnet aggregator endpoint
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';

// Seal Testnet key servers (Open mode - Mysten Labs)
const SEAL_TESTNET_KEY_SERVERS = [
  '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
  '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
];
const SEAL_THRESHOLD = 2;

// Order payload structure
export interface OrderPayload {
    targetPrice: number;   // Price at which to trigger (e.g. 3000 for $3000/ETH)
    amount: number;        // Amount in USDC
    direction: 'buy' | 'sell';
    userEthAddress: string; // Ethereum address for settlement
}

/**
 * Upload encrypted data to Walrus
 * Returns the blob ID for storage reference
 */
export async function uploadToWalrus(data: Uint8Array): Promise<string> {
    console.log('[Walrus] uploadToWalrus called, payload size:', data.length, 'bytes');
    console.log('[Walrus] PUT', `${WALRUS_PUBLISHER}/v1/blobs`);

    const response = await fetch(`${WALRUS_PUBLISHER}/v1/blobs`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream',
        },
        body: data as BodyInit,
    });

    console.log('[Walrus] Response status:', response.status, response.statusText);

    if (!response.ok) {
        const errText = await response.text();
        console.error('[Walrus] Upload failed:', response.status, errText);
        throw new Error(`Walrus upload failed: ${response.status} ${response.statusText} - ${errText}`);
    }

    const result = await response.json();
    console.log('[Walrus] Response body:', JSON.stringify(result).slice(0, 200));

    // Response contains either newlyCreated or alreadyCertified
    if (result.newlyCreated) {
        const blobId = result.newlyCreated.blobObject.blobId;
        console.log('[Walrus] ✅ Upload success (newlyCreated), blobId:', blobId);
        return blobId;
    } else if (result.alreadyCertified) {
        const blobId = result.alreadyCertified.blobId;
        console.log('[Walrus] ✅ Upload success (alreadyCertified), blobId:', blobId);
        return blobId;
    }

    console.error('[Walrus] Unexpected response format:', result);
    throw new Error('Unexpected Walrus response format');
}

/**
 * Fetch blob from Walrus by ID
 */
export async function fetchFromWalrus(blobId: string): Promise<Uint8Array> {
    const response = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);

    if (!response.ok) {
        throw new Error(`Walrus fetch failed: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}

/**
 * Create a Seal client for testnet (used for encrypt only; decryption is agent-side).
 */
function getSealClient(): SealClient {
    const suiClient = new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl('testnet'),
        network: 'testnet',
    });
    return new SealClient({
        suiClient: suiClient as any,
        serverConfigs: SEAL_TESTNET_KEY_SERVERS.map((objectId) => ({ objectId, weight: 1 })),
        verifyKeyServers: false,
    });
}

/**
 * Encrypt order payload with Seal (threshold encryption).
 * Returns the encrypted bytes to be uploaded to Walrus.
 */
/** Generate a random hex string for Seal identity (id must be valid hex). */
function randomHexId(bytes = 16): string {
    const arr = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
    } else {
        for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export async function encryptWithSeal(payload: OrderPayload): Promise<Uint8Array> {
    console.log('[Seal] encryptWithSeal called, payload:', JSON.stringify(payload));
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const id = randomHexId(32); // 32 bytes = 64 hex chars, valid for Seal fromHex(id)
    console.log('[Seal] Identity id (hex):', id.slice(0, 16) + '...');

    const client = getSealClient();
    const { encryptedObject } = await client.encrypt({
        threshold: SEAL_THRESHOLD,
        packageId: SUI_PACKAGE_ID,
        id,
        data,
    });

    console.log('[Seal] ✅ Encrypted length:', encryptedObject.length);
    return encryptedObject;
}

/**
 * Simple XOR encryption with a shared secret (legacy / fallback).
 * Agent uses this for backward compatibility with orders not using Seal.
 */
const AGENT_SHARED_SECRET = 'veiled-agent-secret-2026';

export function encryptPayload(payload: OrderPayload): Uint8Array {
    console.log('[Sui/Encrypt] encryptPayload (XOR) called, payload:', JSON.stringify(payload));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const secret = new TextEncoder().encode(AGENT_SHARED_SECRET);

    const encrypted = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
        encrypted[i] = plaintext[i] ^ secret[i % secret.length];
    }

    console.log('[Sui/Encrypt] ✅ Encrypted length:', encrypted.length);
    return encrypted;
}

export function decryptPayload(encrypted: Uint8Array): OrderPayload {
    const secret = new TextEncoder().encode(AGENT_SHARED_SECRET);

    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
        decrypted[i] = encrypted[i] ^ secret[i % secret.length];
    }

    const text = new TextDecoder().decode(decrypted);
    return JSON.parse(text);
}

/**
 * Encrypt order only (no upload).
 * Returns encrypted bytes that can be sent to agent for upload + Sui order creation.
 * This keeps user's browser stateless - agent handles Walrus upload and Sui transaction.
 * 
 * Uses Seal threshold encryption - agent decrypts via seal_approve_order on Sui.
 */
export async function encryptOrder(payload: OrderPayload): Promise<Uint8Array> {
    console.log('[Seal] Encrypting order with Seal threshold encryption...');
    const encrypted = await encryptWithSeal(payload);
    console.log('[Seal] ✅ Order encrypted:', encrypted.length, 'bytes');
    return encrypted;
}

/**
 * Encrypt order with Seal and upload to Walrus.
 * Use this when user signs and places order (no Sui wallet required for this step).
 * Returns the Walrus blob ID. Agent can fetch the blob and (with Sui Order) decrypt via Seal.
 */
export async function encryptOrderAndUploadToWalrus(payload: OrderPayload): Promise<string> {
    console.log('[Seal+Walrus] Encrypting with Seal and uploading to Walrus...');
    const encrypted = await encryptWithSeal(payload);
    const blobId = await uploadToWalrus(encrypted);
    console.log('[Seal+Walrus] ✅ Done. blobId:', blobId);
    return blobId;
}

/**
 * Create an encrypted order on Sui (Seal + Walrus + on-chain)
 * 1. Encrypt the order payload with Seal
 * 2. Upload to Walrus
 * 3. Create on-chain order with blob ID
 */
export async function createEncryptedOrder(
    payload: OrderPayload,
    signer: Ed25519Keypair
): Promise<{ txDigest: string; blobId: string }> {
    console.log('[Sui] createEncryptedOrder called — Seal encrypt + Walrus + on-chain');
    try {
        // 1. Encrypt payload with Seal
        console.log('[Sui] Step 1: Encrypting payload with Seal...');
        const encrypted = await encryptWithSeal(payload);

        // 2. Upload to Walrus
        console.log('[Sui] Step 2: Uploading to Walrus...');
        const blobId = await uploadToWalrus(encrypted);
        console.log('[Sui] Step 2 done: Uploaded to Walrus, blobId:', blobId);

        // 3. Create on-chain order
        console.log('[Sui] Step 3: Creating on-chain order with blobId...');
        const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' });

        const tx = new Transaction();
        tx.moveCall({
            target: `${SUI_PACKAGE_ID}::order::create_order`,
            arguments: [
                tx.pure.vector('u8', Array.from(new TextEncoder().encode(blobId))),
            ],
        });

        const result = await client.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });

        console.log('[Sui] Step 3 done: Order created on-chain, digest:', result.digest);
        return {
            txDigest: result.digest,
            blobId,
        };
    } catch (e) {
        console.error('[Sui] createEncryptedOrder failed:', e);
        throw e;
    }
}

/**
 * Build the Transaction for create_order(blob_id). Caller signs with Sui wallet and executes.
 */
export function buildCreateOrderTransaction(blobId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
        target: `${SUI_PACKAGE_ID}::order::create_order`,
        arguments: [
            tx.pure.vector('u8', Array.from(new TextEncoder().encode(blobId))),
        ],
    });
    return tx;
}

/**
 * Build create_order(blob_id) transaction bytes for the Sui wallet to sign and execute.
 */
export async function buildCreateOrderTransactionBytes(blobId: string): Promise<Uint8Array> {
    const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' });
    const tx = buildCreateOrderTransaction(blobId);
    return tx.build({ client });
}

/**
 * Cancel an order on Sui
 */
export async function cancelOrder(
    orderId: string,
    signer: Ed25519Keypair
): Promise<string> {
    const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' });

    const tx = new Transaction();
    tx.moveCall({
        target: `${SUI_PACKAGE_ID}::order::cancel_order`,
        arguments: [
            tx.object(orderId),
        ],
    });

    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
    });

    console.log('[Sui] Order cancelled:', result.digest);

    return result.digest;
}

/**
 * Query OrderCreated events
 */
export async function queryOrders(): Promise<any[]> {
    const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' });

    const events = await client.queryEvents({
        query: {
            MoveEventType: `${SUI_PACKAGE_ID}::order::OrderCreated`,
        },
        limit: 50,
    });

    return events.data.map((event: SuiEvent) => ({
        orderId: (event.parsedJson as any).order_id,
        user: (event.parsedJson as any).user,
        blobId: new TextDecoder().decode(
            new Uint8Array((event.parsedJson as any).blob_id)
        ),
        timestamp: event.timestampMs,
    }));
}
