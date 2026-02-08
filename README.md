# Veiled 

**Privacy-First Limit Orders & Agentic Finance on Uniswap v4**

Veiled Protocol redefines DeFi execution by combining privacy, off-chain intent matching, and on-chain settlement. It leverages Uniswap v4 Hooks, Sui (for decentralized agent coordination), and the Yellow Network (for high-frequency state channels) to solve MEV, pre-trade signal leakage, and execution latency.

## 🚀 Key Features

### 1. Private Limit Orders (Sui + Seal + Walrus)
- **Encryption**: Orders are encrypted client-side using **Seal** (Threshold Encryption).
- **Storage**: Encrypted order blobs are stored immutably on **Walrus**.
- **Anchoring**: Order existence and lifecycle are verified on **Sui**, acting as a decentralized bulletin board.
- **Execution**: "Ghost Agents" monitor the market, decrypt orders when conditions are met, and settle them on **Uniswap v4** via a custom Hook.

### 2. Dynamic Orders (Yellow Network)
- **High-Frequency**: Powered by **Yellow Network** state channels for sub-second updates.
- **Trailing Stops**: Users can set trailing buy/sell orders that track market movements off-chain.
- **Gas-Free Updates**: Adjust prices and amounts instantly without on-chain transactions until settlement.

### 3. Agentic Finance
- **Autonomous Execution**: A network of agents manages the complexity of private order matching and multi-chain coordination.
- **MEV Protection**: By keeping intents private until the exact moment of execution, Veiled eliminates front-running and sandwich attacks.

## 🛠 Tech Stack

- **Uniswap v4**: Custom Hooks for settlement logic.
- **Sui**: Order lifecycle management and agent coordination.
- **Walrus**: Decentralized storage for encrypted intents.
- **Seal**: Threshold encryption service.
- **Yellow Network**: State channels for dynamic, high-speed interactions.
- **Next.js**: Modern, cyberpunk-themed frontend interface.
- **Foundry**: Smart contract development and testing.

## 📦 Installation

### Prerequisites
- Node.js (v18+)
- Foundry (Forge, Cast, Anvil)
- Sui CLI

### 1. Clone the Repository
```bash
git clone https://github.com/yourusername/veiled-protocol.git
cd veiled-protocol
```

### 2. Install Dependencies
```bash
npm install
cd web && npm install
```

### 3. Environment Setup
Create a `.env` file in the root directory:
```env
PRIVATE_KEY=your_ethereum_private_key
RPC_URL=your_eth_rpc_url
SUI_PRIVATE_KEY=your_sui_private_key
VEILED_CONTRACT_ADDRESS=deployed_hook_address
```

## 🏃‍♂️ Usage

### Start the Ghost Agent
The agent listens for WebSocket connections from the frontend and monitors market prices.
```bash
# In the root directory
npx ts-node agent.ts
```

### Start the Frontend
Launch the trading interface.
```bash
# In the web directory
npm run dev
```
Visit `http://localhost:3000` to access the Veiled Terminal.

### Testing
Run the Foundry test suite to verify contract logic.
```bash
forge test
```

## 📜 License
MIT
