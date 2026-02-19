# SPAT Agent

Production-oriented scaffold for a dedicated **SPAT Agent** with:

- Agent-owned on-chain vault (`SPATAgentVault`) for SPAT custody/spending
- Authenticated wallet login (challenge + signature)
- Signature request flow for token spending authorization
- SPAT-priced task/workflow service endpoints
- Updatable skill/task model (OpenClaw-style service layer extension)

## Your live setup (confirmed)

- SPAT token: `0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf`
- Controller EOA (owner): `0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d`
- Vault deployed: ✅
- Initial 500000 SPAT funding to vault: ✅

## Project structure

- `contracts/SPATAgentVault.sol` - owner-signature controlled vault
- `backend/server.js` - auth + billing + task APIs
- `frontend/index.html` - simple MetaMask login/task UI
- `hardhat.config.js` + `scripts/deploy.js` - deployment utilities

## Backend API

- `GET /auth/challenge`
- `POST /auth/verify`
- `GET /pricing`
- `POST /tasks/create` (returns EIP-712 typed data for owner spend signature)
- `POST /tasks/confirm-spend` (relayer mode: backend submits on-chain spend)
- `POST /tasks/confirm-spend-direct` (direct mode: owner submits tx, backend verifies and continues task)
- `GET /tasks/:taskId`

## Run locally

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:8787`.

## Deploy contract (if needed on another chain)

```bash
cp .env.example .env
# fill RPC_URL, DEPLOYER_PK, SPAT_TOKEN
npx hardhat run scripts/deploy.js --network mainnet
```

## Important production notes

Current code provides secure primitives + flow scaffolding. Before mainnet production:

1. Verify and relay owner signature to on-chain `spend(...)` call (or owner direct submit)
2. Persist sessions/tasks in Redis/Postgres
3. Enforce SIWE (EIP-4361), HTTPS-only, strict CORS, and rate limits
4. Add role model (admin/operator/auditor)
5. Add full workflow engine + skill install/update registry
6. Add on-chain event indexing for transparent SPAT usage ledger

## OpenClaw-style skill updates

Implement skill operations under `TASK_AUTOMATION` / `SERVICE_SKILL_UPDATE` handlers:

- Install skill bundle
- Validate signed package/checksum
- Hot-reload skill registry
- Versioned rollback

This keeps behavior aligned with updateable agent skill file architecture.
