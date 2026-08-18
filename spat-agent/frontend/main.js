import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SiweMessage } from "https://esm.sh/siwe@3.0.0";

// ── config ─────────────────────────────────────────────────────────────────────
const cfg         = window.SPAT_CONFIG || {};
const BACKEND     = cfg.BACKEND      || "http://localhost:8787";
const MCP_SERVER  = cfg.MCP_SERVER   || "http://localhost:8788";
const SPAT_TOKEN  = cfg.SPAT_TOKEN   || "0x7f18bdbe376b3b0648ad75da2fcc52f8c107bcdf";
const CHAIN_ID    = Number(cfg.CHAIN_ID || 8453);

const erc20Abi  = ["function approve(address spender,uint256 amount) external returns (bool)"];
const usageAbi  = ["function charge(uint8 actionType, bytes32 requestId) external"];

// ── state ──────────────────────────────────────────────────────────────────────
let provider;
let signer;
let address;
let usageContractAddress = cfg.USAGE_CONTRACT || "";
let currentAction        = "runWorkflow";
let busy                 = false;
const llmHistory         = [];   // {role, content}[]

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl       = $("status");
const authStateEl    = $("authState");
const addressEl      = $("address");
const validationEl   = $("validation");
const historyEl      = $("history");
const agentBadgeEl   = $("agentBadge");
const agentAddressEl = $("agentAddress");
const llmStatusEl    = $("llmStatus");
const chainIdDisplay = $("chainIdDisplay");

// ── utilities ──────────────────────────────────────────────────────────────────
function setStatus(msg, type = "ok") {
  statusEl.className   = type;
  statusEl.textContent = msg;
}
function setTimeline(step) {
  const order = ["validate", "connect", "auth", "approve", "charge", "execute"];
  const i     = order.indexOf(step);
  document.querySelectorAll("#timeline li").forEach((li) => {
    const idx = order.indexOf(li.dataset.step);
    li.classList.remove("done", "current", "todo");
    if      (idx < i)  li.classList.add("done");
    else if (idx === i) li.classList.add("current");
    else                li.classList.add("todo");
  });
}
function pillClass(status) {
  if (status === "done")    return "pill done";
  if (status === "failed")  return "pill failed";
  if (status === "running") return "pill running";
  return "pill";
}
function apiGet(path)        { return fetch(`${BACKEND}${path}`, { credentials: "include" }); }
function apiPost(path, body) {
  return fetch(`${BACKEND}${path}`, {
    method:      "POST",
    credentials: "include",
    headers:     { "Content-Type": "application/json" },
    body:        JSON.stringify(body),
  });
}

// ── page nav ───────────────────────────────────────────────────────────────────
function setupPageNav() {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".page-panel").forEach((p) => p.classList.add("hidden"));
      $(`page-${btn.dataset.page}`).classList.remove("hidden");

      // Lazy-load page data
      if (btn.dataset.page === "a2a")     loadAgentCard();
      if (btn.dataset.page === "history") refreshHistory();
    });
  });
}

// ── agent info banner ──────────────────────────────────────────────────────────
async function loadAgentInfo() {
  try {
    const r    = await apiGet("/agent/info");
    const info = await r.json();
    agentAddressEl.textContent = info.address ? info.address.slice(0, 10) + "…" : "not configured";
    chainIdDisplay.textContent = info.chainId || CHAIN_ID;

    const llmR  = await apiGet("/llm/status");
    const llmI  = await llmR.json();
    llmStatusEl.className   = llmI.configured ? "ok" : "err";
    llmStatusEl.textContent = llmI.configured ? `✓ ${llmI.model}` : "not configured";
    $("llmModelDisplay").textContent = llmI.model || "-";

    agentBadgeEl.textContent  = "online";
    agentBadgeEl.className    = "badge green";
  } catch {
    agentBadgeEl.textContent = "offline";
    agentBadgeEl.className   = "badge red";
  }
}

// ── wallet ─────────────────────────────────────────────────────────────────────
async function ensureCorrectChain() {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID)
    throw new Error(`Wrong network. Please switch wallet to chain ${CHAIN_ID} (Base).`);
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("No wallet detected. Install MetaMask or Coinbase Wallet.");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer   = await provider.getSigner();
  await ensureCorrectChain();
  address  = await signer.getAddress();
  addressEl.textContent = address;
  $("connectBtn").textContent = address.slice(0, 8) + "…";
}

// ── SIWE auth ──────────────────────────────────────────────────────────────────
async function siweLogin() {
  const nonceRes = await apiGet("/auth/nonce");
  const { nonce } = await nonceRes.json();

  // BUG FIX: use SiweMessage constructor instead of hand-crafted string
  const siweMsg = new SiweMessage({
    domain:    window.location.host,
    address,
    statement: "Sign in to SPAT Agent",
    uri:       window.location.origin,
    version:   "1",
    chainId:   CHAIN_ID,
    nonce,
    issuedAt:  new Date().toISOString(),
  });
  const message   = siweMsg.prepareMessage();
  const signature = await signer.signMessage(message);

  const verify = await apiPost("/auth/verify", { message, signature });
  if (!verify.ok) throw new Error("SIWE verify failed");

  authStateEl.className   = "ok";
  authStateEl.textContent = "authenticated ✓";
}

// ── quote ──────────────────────────────────────────────────────────────────────
async function loadQuote() {
  const r = await apiGet("/usage/quote");
  if (!r.ok) throw new Error("Could not load quote (are you logged in?)");
  const data = await r.json();
  usageContractAddress = data.usageContract;
  if (!usageContractAddress) throw new Error("Missing usage contract address in backend quote");
  return data.actionCosts;
}

// ── form helpers ───────────────────────────────────────────────────────────────
function randomRequestId() { return ethers.hexlify(ethers.randomBytes(32)); }
function actionToType(a)   { return a === "makeTask" ? 0 : a === "runWorkflow" ? 1 : 2; }
function num(id)           { return Number($(`${id}`)?.value || 0); }
function str(id)           { return ($(`${id}`)?.value || "").trim(); }

// ── tab switching ──────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentAction = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
      $(`panel-${currentAction}`).classList.remove("hidden");
      validateCurrentForm();
    });
  });
}

// ── validation ─────────────────────────────────────────────────────────────────
function validateCurrentForm() {
  const errors = [];
  if (currentAction === "runWorkflow") {
    if (num("wfUsdc") < 1)       errors.push("USDC value must be ≥ 1.");
    if (!str("wfObjective"))      errors.push("Objective is required.");
  }
  if (currentAction === "useService") {
    if (num("tkUsdc") < 1)       errors.push("USDC value must be ≥ 1.");
    if (!str("tkName"))           errors.push("Token name is required.");
    if (!str("tkSymbol"))         errors.push("Token symbol is required.");
    if (!str("tkSupply"))         errors.push("Token supply is required.");
  }
  if (currentAction === "makeTask") {
    if (num("tsUsdc") < 1)        errors.push("USDC value must be ≥ 1.");
    if (num("tsRewardUsdc") < 5)  errors.push("Reward must be ≥ 5 USDC.");
    if (!str("tsTarget"))         errors.push("Target is required.");
  }
  if (errors.length) {
    validationEl.className   = "validation err";
    validationEl.textContent = errors.join(" ");
    return { ok: false };
  }
  validationEl.className   = "validation ok";
  validationEl.textContent = "Looks good ✅";
  return { ok: true };
}

// ── payload builder ────────────────────────────────────────────────────────────
function buildPayload() {
  if (currentAction === "runWorkflow") {
    return {
      payment:  { usdcValue: num("wfUsdc") },
      name:     str("wfName")      || "base-app-builder",
      objective:str("wfObjective") || "create_web3_app",
      appType:  str("wfAppType")   || "web-app",
      features: str("wfFeatures").split(",").map((v) => v.trim()).filter(Boolean),
      steps:    str("wfWebhook") ? [{ type: "webhook", url: str("wfWebhook"), method: "POST" }] : undefined,
    };
  }
  if (currentAction === "useService") {
    return {
      payment: { usdcValue: num("tkUsdc") },
      service: "token-creator",
      params:  {
        name:           str("tkName"),
        symbol:         str("tkSymbol"),
        supply:         str("tkSupply"),
        basedOnProject: str("tkProject") || undefined,
        deployWebhook:  str("tkWebhook") || undefined,
      },
    };
  }
  return {
    payment:      { usdcValue: num("tsUsdc") },
    taskType:     "social-growth",
    title:        str("tsTitle")  || "Farcaster growth quest",
    platform:     str("tsPlatform") || "farcaster",
    socialAction: str("tsAction")   || "follow_like_recast",
    target:       str("tsTarget"),
    details:      str("tsDetails"),
    reward:       { tokenAddress: str("tsRewardToken"), usdcValuePerCompletion: num("tsRewardUsdc") },
  };
}

// ── main action flow ───────────────────────────────────────────────────────────
async function runFlow() {
  if (busy) return;
  busy = true;
  const runBtn = $("runBtn");
  runBtn.disabled = true;

  try {
    setTimeline("validate");
    if (!validateCurrentForm().ok) throw new Error("Fix validation errors first.");

    setTimeline("connect");
    setStatus("Connecting wallet…");
    if (!signer) await connectWallet();
    await ensureCorrectChain();

    setTimeline("auth");
    setStatus("Signing SIWE login…");
    await siweLogin();

    setStatus("Loading quote…");
    const costs  = await loadQuote();
    const action = currentAction;
    const amount = costs[action];
    if (!amount) throw new Error(`No configured cost for action '${action}'`);

    const actionType = actionToType(action);
    const requestId  = randomRequestId();
    const payload    = buildPayload();

    setTimeline("approve");
    setStatus("Requesting SPAT approve()…");
    const token     = new ethers.Contract(SPAT_TOKEN, erc20Abi, signer);
    const approveTx = await token.approve(usageContractAddress, amount);
    await approveTx.wait();

    setTimeline("charge");
    setStatus("Charging in SPAT on-chain…");
    const usage    = new ethers.Contract(usageContractAddress, usageAbi, signer);
    const chargeTx = await usage.charge(actionType, requestId);
    const rcpt     = await chargeTx.wait();

    setTimeline("execute");
    setStatus("Verifying payment + executing…");
    const execRes = await apiPost("/usage/execute", { txHash: rcpt.hash, action, requestId, payload });

    if (!execRes.ok) {
      const e = await execRes.json().catch(() => ({}));
      throw new Error(e.error || "execute failed");
    }

    setStatus("Done ✅ Action executed successfully");
    await refreshHistory();
  } catch (e) {
    setStatus(e.message || "Flow failed", "err");
  } finally {
    busy            = false;
    runBtn.disabled = false;
  }
}

// ── history ────────────────────────────────────────────────────────────────────
async function refreshHistory() {
  try {
    const r = await apiGet("/jobs");
    if (!r.ok) { historyEl.textContent = "Login and run an action to view history."; return; }
    const data = await r.json();
    const jobs = (data.jobs || []).slice().reverse();
    if (!jobs.length) { historyEl.textContent = "No jobs yet."; return; }
    historyEl.innerHTML = jobs.map((j) => `
      <div class="history-item">
        <span class="${pillClass(j.action)}">${j.action}</span>
        <span class="${pillClass(j.status)}">${j.status}</span>
        <small style="color:#888">&nbsp;${j.id} · ${new Date(j.updatedAt).toLocaleString()}</small>
        ${j.error ? `<div class="err" style="font-size:12px;margin-top:2px">${j.error}</div>` : ""}
      </div>`).join("");
  } catch {
    historyEl.textContent = "Failed to load history.";
  }
}

// ── LLM Chat ───────────────────────────────────────────────────────────────────
function appendLlmMsg(role, text) {
  const el     = document.createElement("div");
  el.className = `llm-msg ${role}`;
  el.textContent = text;
  $("llmMsgs").appendChild(el);
  $("llmMsgs").scrollTop = 9999;
}

async function sendLlmMessage() {
  const input = $("llmInput");
  const text  = input.value.trim();
  if (!text) return;
  input.value = "";

  llmHistory.push({ role: "user", content: text });
  appendLlmMsg("user", text);

  const sendBtn = $("llmSendBtn");
  sendBtn.disabled = true;
  sendBtn.textContent = "…";

  try {
    const r = await apiPost("/llm/chat", { messages: llmHistory });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error("Please connect and login first.");
      throw new Error(err.detail || err.error || "LLM request failed");
    }
    const data = await r.json();
    llmHistory.push({ role: "assistant", content: data.reply });
    appendLlmMsg("agent", data.reply);
  } catch (e) {
    appendLlmMsg("agent", `⚠ ${e.message}`);
  } finally {
    sendBtn.disabled    = false;
    sendBtn.textContent = "Send";
  }
}

async function runAssist() {
  const intent = $("assistInput").value.trim();
  if (!intent) return;
  const btn = $("assistBtn");
  btn.disabled = true; btn.textContent = "Generating…";

  try {
    const r = await apiPost("/llm/assist", { intent });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error("Please connect and login first.");
      throw new Error(err.detail || err.error || "Assist failed");
    }
    const data = await r.json();
    const pre  = $("assistOutput");
    pre.textContent = JSON.stringify(data.suggestion, null, 2);
    pre.classList.remove("hidden");
  } catch (e) {
    const pre = $("assistOutput");
    pre.textContent = `Error: ${e.message}`;
    pre.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "✨ Generate Payload";
  }
}

async function runWfAssist() {
  const intent = prompt("Describe what you want to build:");
  if (!intent) return;
  try {
    const r = await apiPost("/llm/assist", { intent });
    if (!r.ok) throw new Error("Login first");
    const data = await r.json();
    const s    = data.suggestion;
    if (s?.objective) $("wfObjective").value = s.objective;
    if (s?.name)      $("wfName").value      = s.name;
    if (s?.appType)   $("wfAppType").value   = s.appType;
    if (s?.features)  $("wfFeatures").value  = (s.features || []).join(", ");
    validateCurrentForm();
  } catch (e) {
    alert(e.message);
  }
}

// ── A2A ────────────────────────────────────────────────────────────────────────
async function loadAgentCard() {
  try {
    const r    = await fetch(`${BACKEND}/.well-known/agent.json`);
    const card = await r.json();
    $("agentCardPre").textContent = JSON.stringify(card, null, 2);
  } catch (e) {
    $("agentCardPre").textContent = `Error: ${e.message}`;
  }
}

async function discoverAgent() {
  const url = $("discoverUrl").value.trim();
  if (!url) return;
  try {
    const r   = await apiPost("/a2a/agents/discover", { url });
    const d   = await r.json();
    if (!d.ok) throw new Error(d.error || "discover failed");
    renderPeers();
  } catch (e) {
    alert(`Discover failed: ${e.message}`);
  }
}

async function renderPeers() {
  try {
    const r    = await apiGet("/a2a/agents");
    const data = await r.json();
    const list = data.agents || [];
    if (!list.length) { $("peerList").textContent = "No peers discovered yet."; return; }
    $("peerList").innerHTML = list.map((a) => `
      <div class="a2a-agent-card">
        <strong>${a.name || a.url}</strong>
        <span class="muted" style="margin-left:6px">${a.url}</span><br/>
        ${a.card ? `<span class="muted">${a.card.description || ""}</span><br/>
        ${(a.card.skills || []).map((s) => `<span class="skill-chip">${s.id}</span>`).join("")}` : ""}
        ${a.lastSeen ? `<div class="muted" style="margin-top:4px">Last seen: ${new Date(a.lastSeen).toLocaleString()}</div>` : ""}
      </div>`).join("");
  } catch { $("peerList").textContent = "Could not load peer list."; }
}

async function callPeerAgent() {
  const url   = $("callUrl").value.trim();
  const skill = $("callSkill").value.trim();
  const msg   = $("callMsg").value.trim();
  if (!url || !msg) { alert("URL and message required"); return; }

  const btn = $("callAgentBtn");
  btn.disabled = true; btn.textContent = "Calling…";

  try {
    const r    = await apiPost("/a2a/agents/call", { url, skill, message: msg });
    const data = await r.json();
    const pre  = $("callResult");
    pre.textContent = JSON.stringify(data, null, 2);
    pre.classList.remove("hidden");
  } catch (e) {
    const pre = $("callResult");
    pre.textContent = `Error: ${e.message}`;
    pre.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Call Agent";
  }
}

// ── x402 / MCP ────────────────────────────────────────────────────────────────
async function testX402() {
  const btn = $("x402TestBtn");
  btn.disabled = true;
  try {
    const r    = await fetch(`${BACKEND}/x402/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:   JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    const data = await r.json();
    const pre  = $("x402Result");
    pre.textContent = `HTTP ${r.status}\n` + JSON.stringify(data, null, 2);
    pre.classList.remove("hidden");
  } catch (e) {
    $("x402Result").textContent = `Error: ${e.message}`;
    $("x402Result").classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function listMcpTools() {
  const btn = $("mcpListBtn");
  btn.disabled = true;
  try {
    const r    = await fetch(`${MCP_SERVER}/`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list", params: {} }),
    });
    const data = await r.json();
    const pre  = $("mcpResult");
    pre.textContent = JSON.stringify(data?.result?.tools?.map((t) => ({ name: t.name, description: t.description })) || data, null, 2);
    pre.classList.remove("hidden");
  } catch (e) {
    $("mcpResult").textContent = `Error: ${e.message}. Make sure MCP server is running on ${MCP_SERVER}`;
    $("mcpResult").classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

// ── init ───────────────────────────────────────────────────────────────────────
setupPageNav();
setupTabs();
validateCurrentForm();
loadAgentInfo();

// Input listeners
["wfObjective","wfUsdc","tkName","tkSymbol","tkSupply","tkUsdc","tsTarget","tsUsdc","tsRewardUsdc"]
  .forEach((id) => { const el = $(id); if (el) el.addEventListener("input", validateCurrentForm); });

// Button listeners
$("connectBtn").addEventListener("click",        () => connectWallet().catch((e) => alert(e.message)));
$("runBtn").addEventListener("click",            runFlow);
$("refreshHistoryBtn").addEventListener("click", refreshHistory);
$("llmSendBtn").addEventListener("click",        sendLlmMessage);
$("assistBtn").addEventListener("click",         runAssist);
$("wfAssistBtn").addEventListener("click",       runWfAssist);
$("discoverBtn").addEventListener("click",       discoverAgent);
$("callAgentBtn").addEventListener("click",      callPeerAgent);
$("x402TestBtn").addEventListener("click",       testX402);
$("mcpListBtn").addEventListener("click",        listMcpTools);

$("llmInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendLlmMessage(); }
});
