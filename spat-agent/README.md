# SPAT Agent

Token-powered AI agent scaffold with:
- Agent-owned treasury wallet (controller: `0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d`)
- Usage billing in `$SPAT` (`0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf`)
- SIWE login (wallet signature auth)
- Signature-gated spending flow (user signs login + on-chain approval)
- Skill-file updatability like OpenClaw agents

## What this scaffold includes

1. `contracts/SPATAgentTreasury.sol`
   - Holds SPAT funds for the agent
   - Controlled by owner EOA (your provided address)
   - Can transfer SPAT to service wallets, refund users, or rotate controller

2. `contracts/SPATAgentUsage.sol`
   - Registers billable actions (`makeTask`, `runWorkflow`, `useService`)
   - Charges users in SPAT with `transferFrom(user, treasury, amount)`
   - Supports per-action dynamic pricing

3. `backend/server.ts`
   - SIWE nonce + verify endpoints (wallet login)
   - Creates usage quote and verifies authenticated session
   - Calls charging contract method after user allowance/approval exists

4. `frontend/wallet-flow.md`
   - Wallet connect
   - SIWE signature login
   - Approval/signature request for SPAT spending
   - Call backend for usage execution

## Required chain details before deployment

Set these before deploying:
- `CHAIN_ID`
- `RPC_URL`
- Deployer private key (for deployment only)

## Deployment sequence

1. Deploy `SPATAgentTreasury` with:
   - owner/controller = `0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d`
   - SPAT token = `0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf`

2. Deploy `SPATAgentUsage` with:
   - SPAT token address
   - treasury contract address

3. From funding wallet, transfer initial treasury amount:
   - `500000 * 10^tokenDecimals` SPAT

4. Point backend env to deployed addresses.

## Funding command template (cast)

```bash
cast send 0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf \
  "transfer(address,uint256)" \
  <TREASURY_ADDRESS> \
  <AMOUNT_WEI> \
  --private-key $FUNDER_PK \
  --rpc-url $RPC_URL
```

> `AMOUNT_WEI` = `500000 * 10^decimals` (confirm token decimals first).

## Backend hardening implemented

- SIWE verification is now real (signature + nonce + chain check).
- Session cookies hardened (`httpOnly`, `sameSite`, production `secure`).
- Optional Redis session store (`REDIS_URL`) for production durability.
- Rate limiting added for `/auth/*` and `/usage/*` endpoints.
- Usage execution verifies on-chain `Charged` event before queueing work.
- Action + amount + requestId + user address are validated against receipt logs.

## New implementation: frontend + deployment scripts

- `frontend/index.html` + `frontend/main.js`
  - Connect wallet
  - SIWE sign-in
  - `approve()` for SPAT
  - `charge()` on usage contract
  - backend payment confirmation (`/usage/execute`)

- `onchain/*` (Hardhat)
  - compile contracts from `../contracts`
  - deploy treasury + usage contracts
  - prints funding command for 500,000 SPAT transfer

### Quick run

Backend:

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

Frontend (static):

```bash
cd frontend
cp config.example.js config.js
python3 -m http.server 3000
```

Onchain deployment:

```bash
cd onchain
npm install
cp .env.example .env
npm run build
npm run deploy
```

## Final step implementation (wired runtime)

1) Deploy contracts with `onchain/` and copy the deployed `SPATAgentUsage` address.

2) Set backend runtime vars:

```bash
cd backend
cp .env.production.example .env
# edit CHAIN_ID, RPC_URL, USAGE_CONTRACT, ALLOWED_ORIGIN, SESSION_SECRET, REDIS_URL
```

3) Set frontend runtime vars:

```bash
cd frontend
cp config.example.js config.js
# edit BACKEND, CHAIN_ID, USAGE_CONTRACT
```

4) Start both with one command:

```bash
cd ..
chmod +x scripts/start-local.sh scripts/stop-local.sh
./scripts/start-local.sh
```

Stop services:

```bash
./scripts/stop-local.sh
```

## Security notes

- Keep treasury ownership on a multisig when possible (Safe preferred).
- Use per-user spend caps and expirations in frontend policy.
- Add server-side risk checks for automation tasks before executing.
- Add Redis/session store in production (avoid in-memory sessions).
- Add rate limiting for `/auth/*` and `/usage/*` endpoints.
