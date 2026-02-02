// Basic Walrus Service Aggregator (Mock/Testnet)
// Note: Using a public aggregator or localhost proxy.
// For the purpose of this task, we will mock the encryption and use a public aggregator if available, 
// or simulate the PUT request return.

const AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space"; // Example URL

export interface WalrusResponse {
    newlyCreated?: {
        blobObject: {
            blobId: string;
            size: number;
        }
    };
    alreadyCertified?: {
        blobId: string;
    };
}

export async function uploadToWalrus(data: string, onLog?: (msg: string) => void): Promise<string> {

    // 1. Mock Encryption
    onLog?.("Encrypting data (Mock AES-256)...");
    await new Promise(r => setTimeout(r, 800)); // Simulate work
    const encryptedData = btoa(data); // Simple mock encryption (Base64)
    onLog?.("Encryption complete. Order is obfuscated.");

    // 2. Upload to Walrus
    onLog?.(`Uploading to Walrus Aggregator...`);

    try {
        // Actual fetch to the testnet aggregator
        const response = await fetch(`${AGGREGATOR_URL}/v1/store`, {
            method: "PUT",
            body: encryptedData,
            headers: {
                "Content-Type": "application/octet-stream"
            }
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }

        const result: WalrusResponse = await response.json();

        let blobId = "";
        if (result.newlyCreated) {
            blobId = result.newlyCreated.blobObject.blobId;
        } else if (result.alreadyCertified) {
            blobId = result.alreadyCertified.blobId;
        } else {
            throw new Error("Unexpected response format from Walrus");
        }

        onLog?.(`Blob ID Received: ${blobId}`);
        return blobId;

    } catch (error) {
        onLog?.(`Error uploading to Walrus: ${(error as Error).message}`);
        throw error;
    }
}
