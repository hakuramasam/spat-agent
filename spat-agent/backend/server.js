import express from "express";
import cors from "cors";
import crypto from "crypto";
import { ethers } from "ethers";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("frontend"));

const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const EOA_OWNER = (process.env.EOA_OWNER || "0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d").toLowerCase();
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
const RPC_URL = process.env.RPC_URL || "";
const RELAYER_PK = process.env.RELAYER_PK || "";

// Adjustable billing table (SPAT token smallest unit expected by client, e.g. 18 decimals)
const PRICING = {
  TASK_BASIC: process.env.COST_TASK_BASIC || "1000000000000000000", // 1 SPAT
  TASK_AUTOMATION: process.env.COST_TASK_AUTOMATION || "3000000000000000000", // 3 SPAT
  SERVICE_SKILL_UPDATE: process.env.COST_SKILL_UPDATE || "5000000000000000000" // 5 SPAT
};

const VAULT_ABI = [
  "function spend(address to,uint256 amount,uint256 nonce,uint256 deadline,string purpose,uint8 v,bytes32 r,bytes32 s)"
];

const sessions = new Map();
const tasks = new Map();

function nonceHex() {
  return crypto.randomBytes(16).toString("hex");
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function buildSpendTypedData({ to, amount, purpose }) {
  const spendNonce = Math.floor(Math.random() * 1_000_000_000);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  return {
    domain: {
      name: "SPAT Agent Vault",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: VAULT_ADDRESS
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
    message: { to, amount, nonce: spendNonce, deadline, purpose }
  };
}

async function submitVaultSpend(typedData, ownerSignature) {
  if (!RPC_URL || !RELAYER_PK || !VAULT_ADDRESS) {
    throw new Error("Missing RPC_URL / RELAYER_PK / VAULT_ADDRESS for on-chain spend");
  }

  const recovered = ethers.verifyTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
    ownerSignature
  ).toLowerCase();

  if (recovered !== EOA_OWNER) {
    throw new Error(`Invalid owner signature. expected=${EOA_OWNER} got=${recovered}`);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, relayer);

  const sig = ethers.Signature.from(ownerSignature);
  const { to, amount, nonce, deadline, purpose } = typedData.message;

  const tx = await vault.spend(
    to,
    amount,
    nonce,
    deadline,
    purpose,
    sig.v,
    sig.r,
    sig.s
  );

  const receipt = await tx.wait();
  return { txHash: tx.hash, blockNumber: receipt?.blockNumber ?? null };
}

app.get("/auth/challenge", (_req, res) => {
  const n = nonceHex();
  sessions.set(n, { createdAt: Date.now(), used: false });
  res.json({ nonce: n, message: `Sign this message to login to SPAT Agent. Nonce: ${n}` });
});

app.post("/auth/verify", async (req, res) => {
  try {
    const { address, signature, nonce } = req.body;
    const challenge = sessions.get(nonce);
    if (!challenge || challenge.used) return res.status(400).json({ error: "Invalid nonce" });

    const msg = `Sign this message to login to SPAT Agent. Nonce: ${nonce}`;
    const signer = ethers.verifyMessage(msg, signature).toLowerCase();

    if (signer !== String(address).toLowerCase()) {
      return res.status(401).json({ error: "Signature mismatch" });
    }

    challenge.used = true;
    const sessionToken = crypto.randomBytes(24).toString("hex");
    sessions.set(sessionToken, { address: signer, createdAt: Date.now() });

    res.json({ ok: true, sessionToken, address: signer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/pricing", (_req, res) => {
  res.json({ pricing: PRICING });
});

app.post("/tasks/create", (req, res) => {
  const { sessionToken, kind, params } = req.body;
  const session = sessions.get(sessionToken);
  if (!session?.address) return res.status(401).json({ error: "Not logged in" });

  const selectedKind = kind || "TASK_BASIC";
  const amount = PRICING[selectedKind];
  if (!amount) return res.status(400).json({ error: "Unknown task kind" });
  if (!VAULT_ADDRESS) return res.status(500).json({ error: "VAULT_ADDRESS not configured" });

  const taskId = makeId("task");
  const purpose = `SPAT Agent usage: ${selectedKind} (${taskId})`;

  const typedData = buildSpendTypedData({
    to: session.address,
    amount,
    purpose
  });

  tasks.set(taskId, {
    taskId,
    owner: session.address,
    kind: selectedKind,
    params: params || {},
    amount,
    purpose,
    typedData,
    status: "AWAITING_OWNER_SIGNATURE",
    createdAt: new Date().toISOString()
  });

  res.json({
    ok: true,
    taskId,
    status: "AWAITING_OWNER_SIGNATURE",
    price: amount,
    ownerSignerRequired: EOA_OWNER,
    typedData
  });
});

app.post("/tasks/confirm-spend", async (req, res) => {
  try {
    const { sessionToken, taskId, ownerSignature } = req.body;
    const session = sessions.get(sessionToken);
    if (!session?.address) return res.status(401).json({ error: "Not logged in" });

    const task = tasks.get(taskId);
    if (!task || task.owner !== session.address) return res.status(404).json({ error: "Task not found" });
    if (!ownerSignature) return res.status(400).json({ error: "ownerSignature required" });

    task.status = "SPEND_SUBMITTING";
    task.ownerSignature = ownerSignature;
    task.updatedAt = new Date().toISOString();

    const onchain = await submitVaultSpend(task.typedData, ownerSignature);

    task.status = "SPEND_CONFIRMED";
    task.onchain = onchain;
    task.updatedAt = new Date().toISOString();

    task.status = "RUNNING";
    setTimeout(() => {
      task.status = "DONE";
      task.result = {
        summary: `Executed ${task.kind}`,
        completedAt: new Date().toISOString(),
        txHash: task.onchain?.txHash || null
      };
      task.updatedAt = new Date().toISOString();
    }, 500);

    res.json({ ok: true, taskId, status: task.status, onchain });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/tasks/:taskId", (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json(task);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "SPAT Agent API",
    chainId: CHAIN_ID,
    owner: EOA_OWNER,
    vault: VAULT_ADDRESS || null,
    relayerReady: Boolean(RPC_URL && RELAYER_PK)
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`SPAT Agent backend running on :${port}`);
});
