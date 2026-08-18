# SPAT Agent v2.0

A **complete, production-ready AI agent** with:

- 🤖 **Agent-owned wallet** — autonomous EOA that holds, signs, and spends `$SPAT`
- 💰 **x402 micropayments** — HTTP 402 machine-to-machine payment protocol (no browser needed)
- 🔗 **MCP server** — Model Context Protocol server so Claude/Cursor can call agent tools
- 🤝 **A2A services** — Google A2A spec for agent-to-agent task delegation
- 🧠 **LLM via OpenRouter** — pluggable AI brain (GPT-4o, Claude, Llama, etc.)
- ⛓ **On-chain billing** — `$SPAT` charges verified via smart contract events
- 🔐 **SIWE auth** — Sign-In with Ethereum wallet sessions

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       SPAT Agent v2.0                           │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐ │
│  │  Frontend    │   │  Backend     │   │  MCP Server         │ │
│  │  (port 3000) │──▶│  (port 8787) │   │  (port 8788)        │ │
│  │              │   │              │   │                     │ │
│  │ • Connect    │   │ • SIWE Auth  │   │ • tools/list        │ │
│  │   Wallet     │   │ • Usage API  │   │ • tools/call        │ │
│  │ • SIWE Login │   │ • LLM Chat   │   │ • SSE stream        │ │
│  │ • Pay & Run  │   │ • x402 MW    │   │ • Claude/Cursor     │ │
│  │ • AI Chat    │   │ • A2A Server │   │   compatible        │ │
│  │ • A2A Panel  │   │ • Agent      │   └─────────────────────┘ │
│  │ • x402 Info  │   │   Wallet     │                           │
│  └──────────────┘   └──────┬───────┘                           │
│                            │                                   │
│                    ┌───────▼────────┐                          │
│                    │  Base Mainnet  │                          │
│                    │                │                          │
│                    │ SPATAgentUsage │                          │
│                    │ SPATAgentTreasury                        │
│                    └────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Bug Fixes (v2.0)

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `server.ts` | `callLLM` referenced `timeoutMs` before it was declared | Moved `timeoutMs` declaration before all functions |
| 2 | `server.ts` | `dotenv` not loaded — env vars missing in dev | Added `import "dotenv/config"` at top |
| 3 | `frontend/main.js` | SIWE message was hand-crafted string — fails strict parsers | Use `SiweMessage` constructor with `prepareMessage()` |
| 4 | `server.ts` | CORS headers missing `X-Payment` — x402 headers blocked | Added `X-Payment` to `Access-Control-Allow-Headers` |
| 5 | `server.ts` | No `/auth/me` endpoint — frontend couldn't check session | Added `GET /auth/me` |
| 6 | `contracts/SPATAgentUsage.sol` | No reentrancy guard on `charge()` | Added `ReentrancyGuard` |
| 7 | `contracts/SPATAgentTreasury.sol` | No way to recover accidentally sent ETH/tokens | Added `recoverEth()` and `recoverToken()` |
| 8 | `contracts/SPATAgentUsage.sol` | Default prices not set in constructor | Constructor now sets default prices |
| 9 | `package.json` | `dotenv` missing from dependencies | Added `dotenv ^16.4.5` |
| 10 | `frontend/config.js` | `CHAIN_ID` was `1` (Ethereum mainnet) instead of `8453` (Base) | Fixed to `8453` |

---

## New Features (v2.0)

### 🤖 Agent-Owned Wallet

The agent has its own EOA (Ethereum wallet) configured via `AGENT_PRIVATE_KEY`.

```
GET  /agent/info     → agent identity card (public)
GET  /agent/balance  → agent's SPAT + ETH balance
POST /agent/sign     → agent signs a message (proves ownership)
```

Generate a wallet:
```bash
node -e "const {ethers}=require('ethers'); const w=ethers.Wallet.createRandom(); console.log('PK:', w.privateKey, 'Address:', w.address)"
```

### 💰 x402 Micropayments

x402 is an HTTP 402 Payment Required protocol for **machine-to-machine** payments.
Callers include an `X-Payment` header with a base64-encoded payment proof.

**Paid endpoints:**
```
POST /x402/llm       → LLM chat (0.5 SPAT per call)
POST /x402/workflow  → Workflow execution (3 SPAT per call)
```

**Client flow:**
```bash
# 1. Approve SPAT spend
# 2. Call charge() on-chain → get txHash
# 3. Encode as base64 JSON
PAYMENT=$(echo '{"txHash":"0x...","payer":"0x..."}' | base64)
# 4. Call paid endpoint
curl -X POST http://localhost:8787/x402/llm \
  -H "X-Payment: $PAYMENT" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello SPAT Agent"}]}'
```

### 🔗 MCP Server (Model Context Protocol)

Runs on port `8788`. Add to Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "spat-agent": {
      "url": "http://localhost:8788"
    }
  }
}
```

**Available MCP tools:**
| Tool | Description |
|------|-------------|
| `spat_llm_chat` | Send messages to the agent's LLM |
| `spat_build_app` | Build a Base web3 app/website/game |
| `spat_create_token` | Deploy an ERC-20 token on Base |
| `spat_social_growth` | Create a Farcaster growth campaign |
| `spat_agent_info` | Get agent wallet, chain, and capability info |
| `spat_a2a_call` | Call a peer A2A agent by URL |

### 🤝 A2A (Agent-to-Agent) Services

Implements the [Google A2A spec](https://google.github.io/A2A/) for agent discovery and inter-agent task delegation.

```
GET  /.well-known/agent.json    → agent discovery card
POST /a2a                        → receive A2A tasks (JSON-RPC 2.0)
GET  /a2a/agents                 → list known peer agents
POST /a2a/agents/discover        → discover + cache a peer agent
POST /a2a/agents/call            → call a peer agent skill
```

**Supported A2A skills:**
- `llm_chat` — general LLM conversation
- `build_app` — Base web3 app builder
- `create_token` — ERC-20 token deployer
- `social_growth_campaign` — Farcaster growth quests

**Call another agent from your code:**
```js
const task = await fetch("http://localhost:8787/a2a/agents/call", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    url:     "https://other-agent.example.com",
    skill:   "llm_chat",
    message: "What can you do?"
  })
});
```

### 🧠 LLM Endpoints

```
GET  /llm/status    → provider config (public)
POST /llm/chat      → free-form multi-turn chat (auth required)
POST /llm/assist    → natural language → SPAT action payload (auth required)
```

---

## Quick Start

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env: set AGENT_PRIVATE_KEY, RPC_URL, USAGE_CONTRACT
npm install
npm run dev
```

### 2. Frontend

```bash
cd frontend
cp config.example.js config.js
# Edit config.js: set USAGE_CONTRACT
python3 -m http.server 3000
```

### 3. Verify

```bash
curl http://localhost:8787/health
# → {"ok":true,"agentWallet":"0x...","llm":true,"mcp":true,"a2a":true}

curl http://localhost:8787/.well-known/agent.json
# → A2A agent card

curl -X POST http://localhost:8788/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}'
# → MCP tools list
```

---

## Contract Deployment

```bash
cd onchain
cp .env.example .env
# Edit: DEPLOYER_PRIVATE_KEY, RPC_URL, AGENT_OWNER_EOA, SPAT_TOKEN
npm install
npm run build
npm run deploy
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | ✅ | Random 64-byte secret for sessions |
| `CHAIN_ID` | ✅ | Chain ID (8453 = Base mainnet) |
| `RPC_URL` | ✅ | JSON-RPC endpoint |
| `USAGE_CONTRACT` | ✅ | Deployed `SPATAgentUsage` address |
| `SPAT_TOKEN` | — | SPAT ERC-20 address |
| `AGENT_PRIVATE_KEY` | — | Agent wallet private key |
| `OPENROUTER_API_KEY` | — | OpenRouter API key for LLM |
| `OPENROUTER_MODEL` | — | Model slug (default: `openai/gpt-4o-mini`) |
| `X402_FACILITATOR_URL` | — | External x402 facilitator (optional) |
| `MCP_PORT` | — | MCP server port (default: 8788) |
| `A2A_AGENT_REGISTRY` | — | JSON array of peer agents |
| `REDIS_URL` | — | Redis for production sessions |

---

## Security Notes

- Keep `AGENT_PRIVATE_KEY` in a secrets manager in production (never commit it)
- Use a multisig (Safe) for treasury ownership in production
- `OPENROUTER_API_KEY` should be rotated regularly
- Add rate limiting (already included) and monitor for abuse
- `requestCharged` mapping in contract prevents double-spend
- x402 payment proofs are one-time (tied to a specific txHash)
