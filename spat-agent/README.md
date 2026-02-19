# SPAT Agent

This scaffold sets up a dedicated **SPAT Agent** with:

- A dedicated on-chain vault wallet contract for SPAT token custody/spending
- Owner-controlled spending authorization via EIP-712 signature
- Authenticated user login using wallet signature challenge
- Signature request flow for SPAT spending operations

## Given Parameters

- SPAT token: `0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf`
- Controller EOA (owner): `0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d`
- Initial funding target: `500000 SPAT` to vault contract address

## Architecture

1. **SPATAgentVault.sol** (agent-owned wallet)
   - Holds SPAT token
   - Executes `spend(...)` only when a valid owner signature is presented
   - Protects replay with nonce tracking and deadline

2. **Backend API**
   - `GET /auth/challenge` → wallet login challenge nonce
   - `POST /auth/verify` → verifies signature and opens session
   - `POST /spend/request` → creates typed-data payload for owner signature

3. **Agent Services Layer (to add)**
   - Task automation endpoints
   - Workflow execution with SPAT metering per task
   - Skill update/install hooks (OpenClaw-style skill files)

## Deploy + Fund

1. Deploy `SPATAgentVault` with:
   - `token_ = 0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf`
   - `owner_ = 0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d`

2. Transfer `500000 SPAT` from a funded wallet to the deployed vault address.

> Note: Actual token transfer requires signing on the target chain by a wallet that currently holds SPAT.

## Run backend

```bash
npm install
CHAIN_ID=1 VAULT_ADDRESS=0xYourVaultAddress npm start
```

## Security Notes

- Add JWT/session persistence (Redis/Postgres) for production
- Add rate-limit and anti-replay at API level
- Restrict CORS and enforce HTTPS
- Use SIWE (EIP-4361) format for stronger login semantics
- Add on-chain event indexing for accounting/audit dashboard

## Next Build Steps

- Task billing engine (deduct SPAT by action type)
- Service registry: tasks, automation workflows, paid skill invocations
- Skill file updater compatible with OpenClaw AgentSkills pattern
- Admin UI: balances, spend approvals, user sessions, usage analytics
