import express from "express";
import cors from "cors";
import crypto from "crypto";
import { ethers } from "ethers";

const app = express();
app.use(cors());
app.use(express.json());

const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const EOA_OWNER = (process.env.EOA_OWNER || "0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d").toLowerCase();

const sessions = new Map();

function nonce() {
  return crypto.randomBytes(16).toString("hex");
}

app.get("/auth/challenge", (_req, res) => {
  const n = nonce();
  sessions.set(n, { createdAt: Date.now(), used: false });
  res.json({
    nonce: n,
    message: `Sign this message to login to SPAT Agent. Nonce: ${n}`
  });
});

app.post("/auth/verify", async (req, res) => {
  try {
    const { address, signature, nonce } = req.body;
    const data = sessions.get(nonce);
    if (!data || data.used) return res.status(400).json({ error: "Invalid nonce" });

    const msg = `Sign this message to login to SPAT Agent. Nonce: ${nonce}`;
    const signer = ethers.verifyMessage(msg, signature).toLowerCase();

    if (signer !== String(address).toLowerCase()) {
      return res.status(401).json({ error: "Signature mismatch" });
    }

    data.used = true;
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { address: signer, createdAt: Date.now(), used: false });

    res.json({ ok: true, sessionToken: token, address: signer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/spend/request", (req, res) => {
  const { sessionToken, amount, purpose } = req.body;
  const session = sessions.get(sessionToken);
  if (!session?.address) return res.status(401).json({ error: "Not logged in" });

  const spendNonce = Math.floor(Math.random() * 1_000_000_000);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  // This payload must be signed by the owner EOA for on-chain vault spend() execution.
  res.json({
    typedData: {
      domain: {
        name: "SPAT Agent Vault",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: process.env.VAULT_ADDRESS
      },
      types: {
        Spend: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "purpose", type: "string" }
        ]
      },
      primaryType: "Spend",
      message: {
        to: session.address,
        amount,
        nonce: spendNonce,
        deadline,
        purpose: purpose || "SPAT Agent service usage"
      }
    },
    requiresOwner: EOA_OWNER
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, name: "SPAT Agent API" }));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`SPAT Agent backend running on :${port}`);
});
