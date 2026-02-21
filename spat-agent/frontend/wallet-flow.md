# Frontend Wallet Flow (Auth + Spending)

1. Connect wallet.
2. Request nonce from `/auth/nonce`.
3. Build SIWE message and request signature (`personal_sign`).
4. Send SIWE payload to `/auth/verify`.
5. Fetch costs from `/usage/quote`.
6. Before usage, request token spending approval transaction:
   - `SPAT.approve(SPATAgentUsageAddress, amount)`
7. Call `SPATAgentUsage.charge(actionType, requestId)` from user wallet.
8. Send request metadata + tx hash to `/usage/execute`.

This gives:
- authenticated login (signature-based)
- explicit signature/wallet approval for SPAT spending
- on-chain auditable usage payments
