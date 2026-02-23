import { ethers } from "https://esm.sh/ethers@6.13.2";

const cfg = window.SPAT_CONFIG || {};
const BACKEND = cfg.BACKEND || "http://localhost:8787";
const SPAT_TOKEN = cfg.SPAT_TOKEN || "0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf";
const CHAIN_ID = Number(cfg.CHAIN_ID || 8453);

const erc20Abi = ["function approve(address spender,uint256 amount) external returns (bool)"];
const usageAbi = ["function charge(uint8 actionType, bytes32 requestId) external"];

let provider;
let signer;
let address;
let usageContractAddress = cfg.USAGE_CONTRACT || "";
let currentAction = "runWorkflow";

const statusEl = document.getElementById("status");
const authStateEl = document.getElementById("authState");
const addressEl = document.getElementById("address");

function setStatus(msg, err = false) {
  statusEl.className = err ? "err" : "ok";
  statusEl.textContent = msg;
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentAction = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(`panel-${currentAction}`).classList.remove("hidden");
    });
  });
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("No wallet found");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  address = await signer.getAddress();
  addressEl.textContent = address;
}

async function siweLogin() {
  const nonceRes = await fetch(`${BACKEND}/auth/nonce`, { credentials: "include" });
  const { nonce } = await nonceRes.json();

  const domain = window.location.host;
  const origin = window.location.origin;
  const msg = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to SPAT Agent\n\nURI: ${origin}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;

  const signature = await signer.signMessage(msg);
  const verify = await fetch(`${BACKEND}/auth/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg, signature })
  });

  if (!verify.ok) throw new Error("SIWE verify failed");
  authStateEl.textContent = "authenticated";
}

async function loadQuote() {
  const r = await fetch(`${BACKEND}/usage/quote`, { credentials: "include" });
  if (!r.ok) throw new Error("quote failed");
  const data = await r.json();
  usageContractAddress = data.usageContract;
  return data.actionCosts;
}

function randomRequestId() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function actionToType(action) {
  if (action === "makeTask") return 0;
  if (action === "runWorkflow") return 1;
  return 2;
}

function num(id) {
  return Number(document.getElementById(id).value || 0);
}

function str(id) {
  return (document.getElementById(id).value || "").trim();
}

function buildPayload() {
  if (currentAction === "runWorkflow") {
    return {
      payment: { usdcValue: num("wfUsdc") },
      name: str("wfName") || "base-app-builder",
      objective: str("wfObjective") || "create_web3_app",
      appType: str("wfAppType") || "web-app",
      features: str("wfFeatures").split(",").map((v) => v.trim()).filter(Boolean),
      steps: str("wfWebhook")
        ? [{ type: "webhook", url: str("wfWebhook"), method: "POST" }]
        : undefined
    };
  }

  if (currentAction === "useService") {
    return {
      payment: { usdcValue: num("tkUsdc") },
      service: "token-creator",
      params: {
        name: str("tkName"),
        symbol: str("tkSymbol"),
        supply: str("tkSupply"),
        basedOnProject: str("tkProject") || undefined,
        deployWebhook: str("tkWebhook") || undefined
      }
    };
  }

  return {
    payment: { usdcValue: num("tsUsdc") },
    taskType: "social-growth",
    title: str("tsTitle") || "Farcaster growth quest",
    platform: str("tsPlatform") || "farcaster",
    socialAction: str("tsAction") || "follow_like_recast",
    target: str("tsTarget"),
    details: str("tsDetails"),
    reward: {
      tokenAddress: str("tsRewardToken"),
      usdcValuePerCompletion: num("tsRewardUsdc")
    }
  };
}

async function runFlow() {
  try {
    setStatus("Connecting wallet...");
    if (!signer) await connectWallet();

    setStatus("Signing SIWE login...");
    await siweLogin();

    setStatus("Loading quote...");
    const costs = await loadQuote();

    const action = currentAction;
    const amount = costs[action];
    const actionType = actionToType(action);
    const requestId = randomRequestId();
    const payload = buildPayload();

    setStatus("Requesting approve() signature...");
    const token = new ethers.Contract(SPAT_TOKEN, erc20Abi, signer);
    const approveTx = await token.approve(usageContractAddress, amount);
    await approveTx.wait();

    setStatus("Charging in SPAT on-chain...");
    const usage = new ethers.Contract(usageContractAddress, usageAbi, signer);
    const chargeTx = await usage.charge(actionType, requestId);
    const rcpt = await chargeTx.wait();

    setStatus("Verifying payment + executing...");
    const execRes = await fetch(`${BACKEND}/usage/execute`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: rcpt.hash, action, requestId, payload })
    });

    if (!execRes.ok) {
      const e = await execRes.json().catch(() => ({}));
      throw new Error(e.error || "execute failed");
    }

    setStatus("Done ✅ Action executed successfully");
  } catch (e) {
    setStatus(e.message || "Flow failed", true);
  }
}

setupTabs();
document.getElementById("connectBtn").addEventListener("click", connectWallet);
document.getElementById("runBtn").addEventListener("click", runFlow);
