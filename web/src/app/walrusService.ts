// Walrus Service (Real Testnet Publisher)
// Docs: https://docs.walrus.site/usage/client-api.html
const PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space";

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

    // 1. Encoding
    // Using Base64 to represent the binary payload for the PUT body.
    onLog?.("Encoding data...");
    const encryptedData = btoa(data);

    // 2. Upload to Walrus
    onLog?.(`Uploading to Walrus Publisher (${PUBLISHER_URL})...`);

    try {
        // We use ?epochs=1 to specify storage duration (default testnet param)
        const response = await fetch(`${PUBLISHER_URL}/v1/store?epochs=1`, {
            method: "PUT",
            body: encryptedData,
            headers: {
                "Content-Type": "application/octet-stream"
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Walrus Publisher Error (${response.status}): ${errorText}`);
        }

        const result: WalrusResponse = await response.json();

        let blobId = "";
        if (result.newlyCreated) {
            blobId = result.newlyCreated.blobObject.blobId;
        } else if (result.alreadyCertified) {
            blobId = result.alreadyCertified.blobId;
        } else {
            throw new Error("Invalid response from Walrus Publisher");
        }

        onLog?.(`✅ Blob ID Received: ${blobId}`);
        return blobId;

    } catch (error) {
        onLog?.(`❌ Upload Failed: ${(error as Error).message}`);
        throw error;
    }
}
