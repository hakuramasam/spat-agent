import "dotenv/config";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import { SiweMessage } from "siwe";
import { ethers } from "ethers";
import { Redis } from "ioredis";
import { RedisStore } from "connect-redis";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

// ── env ────────────────────────────────────────────────────────────────────────
const {
  SESSION_SECRET,
  NODE_ENV,
  CHAIN_ID,
  RPC_URL,
  USAGE_CONTRACT,
  SPAT_TOKEN,
  ALLOWED_ORIGIN,
  REDIS_URL,
  PORT,
  REQUEST_TIMEOUT_MS,
  WORKFLOW_DEFAULT_WEBHOOK,
  SERVICE_MAP_JSON,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL,
  // Agent wallet
  AGENT_PRIVATE_KEY,
  // x402 / MCP
  X402_FACILITATOR_URL,
  MCP_PORT,
  // A2A
  A2A_AGENT_REGISTRY,
} = process.env;

if (!SESSION_SECRET) throw new Error("SESSION_SECRET is required");
if (!CHAIN_ID)        throw new Error("CHAIN_ID is required");
if (!RPC_URL)         throw new Error("RPC_URL is required");
if (!USAGE_CONTRACT)  throw new Error("USAGE_CONTRACT is required");

// ── timeoutMs (declare before use) ────────────────────────────────────────────
const timeoutMs = Number(REQUEST_TIMEOUT_MS || 20_000);

// ── provider + agent wallet ───────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);

let agentWallet: ethers.Wallet | null = null;
if (AGENT_PRIVATE_KEY) {
  agentWallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);
  console.log(`[wallet] Agent wallet loaded: ${agentWallet.address}`);
} else {
  console.warn("[wallet] AGENT_PRIVATE_KEY not set – agent self-signing disabled");
}

// ── express ───────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// ── types ─────────────────────────────────────────────────────────────────────
type JobStatus = "queued" | "running" | "done" | "failed";
type Action = "makeTask" | "runWorkflow" | "useService";

type Task = {
  id: string; user: string; title: string; details?: string; createdAt: string;
};
type WorkflowRun = {
  id: string; user: string; name: string; input?: Record<string, unknown>;
  status: JobStatus; createdAt: string; updatedAt: string;
  result?: Record<string, unknown>; error?: string;
};
type ServiceRun = {
  id: string; user: string; service: string; params?: Record<string, unknown>;
  status: JobStatus; createdAt: string; updatedAt: string;
  output?: Record<string, unknown>; error?: string;
};
type JobRecord = {
  id: string; requestId: string; user: string; action: Action; txHash: string;
  status: JobStatus; createdAt: string; updatedAt: string;
  artifactId?: string; error?: string;
};
type RuntimeDB = {
  tasks: Task[]; workflowRuns: WorkflowRun[];
  serviceRuns: ServiceRun[]; jobs: JobRecord[];
};
type HttpCallInput = {
  url: string; method?: string;
  headers?: Record<string, string>; body?: unknown;
};
type WorkflowStep = {
  type: "webhook" | "http"; url: string; method?: string;
  headers?: Record<string, string>; body?: unknown;
};
type ServiceConfig = {
  url: string; method?: string;
  headers?: Record<string, string>; authHeaderEnv?: string;
};
type ActionPolicy = { minUsd: number; description: string };

// ── constants ─────────────────────────────────────────────────────────────────
const ACTION_POLICIES: Record<Action, ActionPolicy> = {
  makeTask:    { minUsd: 1, description: "Create task events" },
  runWorkflow: { minUsd: 1, description: "Build/deploy web apps, websites, games on Base" },
  useService:  { minUsd: 1, description: "Create tokens on Base / specialized services" },
};

const actionCosts: Record<Action, string> = {
  makeTask:    "1000000000000000000",
  runWorkflow: "3000000000000000000",
  useService:  "500000000000000000",
};

const actionTypeMap: Record<Action, number> = {
  makeTask: 0, runWorkflow: 1, useService: 2,
};

// ── runtime DB ────────────────────────────────────────────────────────────────
const dataDir = path.join(process.cwd(), "data");
const dbPath  = path.join(dataDir, "runtime-db.json");
const defaultDb: RuntimeDB = { tasks: [], workflowRuns: [], serviceRuns: [], jobs: [] };

async function loadDb(): Promise<RuntimeDB> {
  await mkdir(dataDir, { recursive: true });
  try {
    const raw    = await readFile(dbPath, "utf8");
    const parsed = JSON.parse(raw) as RuntimeDB;
    return {
      tasks:        parsed.tasks        || [],
      workflowRuns: parsed.workflowRuns || [],
      serviceRuns:  parsed.serviceRuns  || [],
      jobs:         parsed.jobs         || [],
    };
  } catch {
    await writeFile(dbPath, JSON.stringify(defaultDb, null, 2));
    return structuredClone(defaultDb);
  }
}
async function saveDb(db: RuntimeDB) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
function newId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// ── service map ───────────────────────────────────────────────────────────────
const serviceMap: Record<string, ServiceConfig> = (() => {
  if (!SERVICE_MAP_JSON) return {};
  try { return JSON.parse(SERVICE_MAP_JSON); }
  catch { console.warn("Invalid SERVICE_MAP_JSON, ignoring"); return {}; }
})();

// ── LLM (OpenRouter) ──────────────────────────────────────────────────────────
const LLM_BASE_URL = OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const LLM_MODEL    = OPENROUTER_MODEL    || "openai/gpt-4o-mini";

async function callLLM(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts?: { model?: string; temperature?: number; max_tokens?: number }
): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer":  ALLOWED_ORIGIN || "http://localhost:3000",
        "X-Title":       "SPAT Agent",
      },
      body: JSON.stringify({
        model:       opts?.model        || LLM_MODEL,
        messages,
        temperature: opts?.temperature  ?? 0.7,
        max_tokens:  opts?.max_tokens   ?? 1024,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ── x402 payment middleware ───────────────────────────────────────────────────
// x402 is a HTTP 402 Payment Required protocol for machine-readable micropayments.
// When a client hits a paid endpoint without a valid payment header, we return 402
// with a payment requirements object. Once they include X-Payment, we verify it
// on-chain or with the facilitator and proceed.

type X402PaymentRequirements = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, string>;
};

function buildX402Requirements(
  resource: string,
  description: string,
  amountWei: string
): X402PaymentRequirements {
  const agentAddress = agentWallet?.address || "0x0000000000000000000000000000000000000000";
  return {
    scheme:             "exact",
    network:            `eip155:${CHAIN_ID}`,
    maxAmountRequired:  amountWei,
    resource,
    description,
    mimeType:           "application/json",
    payTo:              agentAddress,
    maxTimeoutSeconds:  300,
    asset:              SPAT_TOKEN || "0x0000000000000000000000000000000000000000",
    extra: {
      name:   "SPAT Token",
      symbol: "SPAT",
    },
  };
}

async function verifyX402Payment(
  paymentHeader: string,
  requirements: X402PaymentRequirements
): Promise<{ valid: boolean; payer?: string; txHash?: string; error?: string }> {
  // Try external facilitator first
  if (X402_FACILITATOR_URL) {
    try {
      const res = await fetch(`${X402_FACILITATOR_URL}/verify`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ payment: paymentHeader, requirements }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          isValid: boolean; payer?: string; txHash?: string; error?: string;
        };
        return { valid: body.isValid, payer: body.payer, txHash: body.txHash, error: body.error };
      }
    } catch (e) {
      console.warn("[x402] Facilitator check failed, falling back to local verify:", e);
    }
  }

  // Local verify: decode base64 payment header, parse JSON
  try {
    const decoded  = Buffer.from(paymentHeader, "base64").toString("utf8");
    const payment  = JSON.parse(decoded) as { txHash?: string; payer?: string; signature?: string };
    const txHash   = payment.txHash;
    if (!txHash) return { valid: false, error: "missing txHash in payment" };

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1)
      return { valid: false, error: "tx not confirmed" };

    // Check ETH/token transfer to agentWallet
    if (agentWallet) {
      const tx = await provider.getTransaction(txHash);
      if (tx?.to?.toLowerCase() !== agentWallet.address.toLowerCase())
        return { valid: false, error: "payment not directed to agent wallet" };
    }

    return { valid: true, payer: payment.payer, txHash };
  } catch (e: any) {
    return { valid: false, error: String(e?.message || e) };
  }
}

// x402 middleware factory
function x402(amountWei: string, description: string) {
  return async (req: any, res: any, next: any) => {
    const paymentHeader = req.headers["x-payment"] as string | undefined;
    const resource = `${req.protocol}://${req.get("host")}${req.path}`;

    if (!paymentHeader) {
      const requirements = buildX402Requirements(resource, description, amountWei);
      res.setHeader("Content-Type", "application/json");
      return res.status(402).json({
        x402Version: 1,
        error:        "Payment Required",
        accepts:      [requirements],
      });
    }

    const requirements = buildX402Requirements(resource, description, amountWei);
    const result = await verifyX402Payment(paymentHeader, requirements);

    if (!result.valid) {
      return res.status(402).json({
        x402Version: 1,
        error:        `Payment invalid: ${result.error}`,
        accepts:      [requirements],
      });
    }

    // Attach payer info
    req.x402Payer   = result.payer;
    req.x402TxHash  = result.txHash;
    next();
  };
}

// ── A2A (Agent-to-Agent) ──────────────────────────────────────────────────────
// A2A lets agents discover and call each other using the Google A2A spec format.

type A2AAgentCard = {
  name:           string;
  description:    string;
  url:            string;
  version:        string;
  capabilities:   string[];
  skills:         A2ASkill[];
  authentication: { schemes: string[] };
  x402?:          { enabled: boolean; asset: string; minAmount: string };
};

type A2ASkill = {
  id:          string;
  name:        string;
  description: string;
  inputModes:  string[];
  outputModes: string[];
  examples?:   string[];
  tags?:       string[];
};

type A2AMessage = {
  role:  "user" | "agent";
  parts: Array<{ type: "text"; text: string }>;
};

type A2ATask = {
  id:        string;
  sessionId: string;
  status:    { state: "submitted" | "working" | "completed" | "failed"; message?: A2AMessage };
  history?:  A2AMessage[];
  artifacts?: Array<{ name: string; parts: Array<{ type: string; text?: string }> }>;
};

// Our agent's A2A card
function buildAgentCard(): A2AAgentCard {
  const baseUrl = ALLOWED_ORIGIN || `http://localhost:${PORT || 8787}`;
  return {
    name:        "SPAT Agent",
    description: "Token-powered AI agent on Base. Builds web-apps, deploys tokens, and manages social growth campaigns. Accepts $SPAT payments.",
    url:         `${baseUrl}/a2a`,
    version:     "1.0.0",
    capabilities: ["streaming", "pushNotifications", "stateTransitionHistory"],
    skills: [
      {
        id:          "build_app",
        name:        "Build Web App / Game on Base",
        description: "Given an objective and feature list, scaffold and deploy a web3 app on Base mainnet.",
        inputModes:  ["text"],
        outputModes: ["text", "data"],
        examples:    ["Build a social prediction game on Base with wallet login and leaderboard"],
        tags:        ["base", "web3", "app-builder"],
      },
      {
        id:          "create_token",
        name:        "Create ERC-20 Token on Base",
        description: "Deploy a named ERC-20 token on Base with a given symbol and supply.",
        inputModes:  ["text", "data"],
        outputModes: ["data"],
        examples:    ["Deploy QUEST token with 1B supply on Base"],
        tags:        ["base", "erc20", "token"],
      },
      {
        id:          "social_growth_campaign",
        name:        "Launch Social Growth Campaign",
        description: "Create Farcaster / social-media growth quests with on-chain rewards.",
        inputModes:  ["text"],
        outputModes: ["data"],
        examples:    ["Create a Farcaster follow+recast campaign with 5 USDC reward per completion"],
        tags:        ["farcaster", "social", "growth"],
      },
      {
        id:          "llm_chat",
        name:        "LLM Chat (OpenRouter)",
        description: "General-purpose AI chat powered by OpenRouter. Usable by other agents.",
        inputModes:  ["text"],
        outputModes: ["text"],
        tags:        ["llm", "chat", "openrouter"],
      },
    ],
    authentication: { schemes: ["siwe", "x402"] },
    x402: {
      enabled:   true,
      asset:     SPAT_TOKEN || "",
      minAmount: "500000000000000000",
    },
  };
}

// Registry of known peer agents
type PeerAgent = { name: string; url: string; card?: A2AAgentCard; lastSeen?: string };
const peerAgents = new Map<string, PeerAgent>();

// Seed from env
if (A2A_AGENT_REGISTRY) {
  try {
    const list = JSON.parse(A2A_AGENT_REGISTRY) as Array<{ name: string; url: string }>;
    for (const a of list) peerAgents.set(a.url, a);
  } catch { console.warn("[a2a] Invalid A2A_AGENT_REGISTRY, ignoring"); }
}

// Discover and cache a peer agent card
async function fetchAgentCard(agentUrl: string): Promise<A2AAgentCard | null> {
  try {
    const res  = await fetch(`${agentUrl}/.well-known/agent.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const card = (await res.json()) as A2AAgentCard;
    const peer = peerAgents.get(agentUrl) || { name: card.name, url: agentUrl };
    peer.card     = card;
    peer.lastSeen = new Date().toISOString();
    peerAgents.set(agentUrl, peer);
    return card;
  } catch { return null; }
}

// Send a task to a peer agent via A2A
async function sendA2ATask(
  agentUrl: string,
  skill:    string,
  message:  string,
  paymentHeader?: string
): Promise<A2ATask> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paymentHeader) headers["X-Payment"] = paymentHeader;

  const body = {
    jsonrpc: "2.0",
    id:      randomBytes(4).toString("hex"),
    method:  "tasks/send",
    params: {
      id:        randomBytes(8).toString("hex"),
      sessionId: randomBytes(8).toString("hex"),
      message: {
        role:  "user",
        parts: [{ type: "text", text: message }],
      },
      metadata: { skill },
    },
  };

  const res = await fetch(`${agentUrl}/a2a`, {
    method:  "POST",
    headers,
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 402) {
    const data = (await res.json()) as { accepts?: X402PaymentRequirements[] };
    throw Object.assign(new Error("A2A peer requires payment"), { paymentRequired: data.accepts });
  }
  if (!res.ok) throw new Error(`A2A peer error: ${res.status}`);

  const result = (await res.json()) as { result?: A2ATask; error?: { message: string } };
  if (result.error) throw new Error(result.error.message);
  return result.result!;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function doHttpCall(input: HttpCallInput) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(input.url, {
      method:  input.method || "POST",
      headers: { "content-type": "application/json", ...(input.headers || {}) },
      body:    input.body === undefined ? undefined : JSON.stringify(input.body),
      signal:  controller.signal,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }

    return { ok: res.ok, status: res.status, data: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// ── action integrations ───────────────────────────────────────────────────────
async function runWorkflowIntegration(user: string, payload: any) {
  const runName       = payload?.name || "base-app-builder";
  const steps         = (payload?.steps || []) as WorkflowStep[];
  const effectiveSteps =
    steps.length > 0
      ? steps
      : WORKFLOW_DEFAULT_WEBHOOK
      ? [{
          type:   "webhook" as const,
          url:    WORKFLOW_DEFAULT_WEBHOOK,
          method: "POST",
          body:   {
            user, workflow: runName,
            objective: payload?.objective || "create_web3_app",
            appType:   payload?.appType   || "web-app",
            features:  payload?.features  || [],
            chain:     "base-mainnet",
            input:     payload?.input     || {},
            timestamp: new Date().toISOString(),
          },
        }]
      : [];

  if (effectiveSteps.length === 0)
    throw new Error("No workflow steps and WORKFLOW_DEFAULT_WEBHOOK not configured");

  const stepResults: Array<Record<string, unknown>> = [];
  for (const [index, step] of effectiveSteps.entries()) {
    const result = await doHttpCall({
      url:     step.url,
      method:  step.method || "POST",
      headers: step.headers,
      body:    step.body ?? { user, workflow: runName, input: payload?.input || {}, step: index + 1 },
    });
    stepResults.push({ step: index + 1, url: step.url, status: result.status, ok: result.ok, response: result.data });
    if (!result.ok) throw new Error(`Workflow step ${index + 1} failed with status ${result.status}`);
  }

  return { summary: `Workflow ${runName} executed`, stepsExecuted: effectiveSteps.length, stepResults };
}

async function runServiceIntegration(user: string, payload: any) {
  const serviceName = String(payload?.service || "").trim();
  if (!serviceName) throw new Error("payload.service is required for useService");

  if (serviceName === "token-creator") {
    const tokenSpec = {
      name:           payload?.params?.name,
      symbol:         payload?.params?.symbol,
      supply:         payload?.params?.supply,
      basedOnProject: payload?.params?.basedOnProject || null,
      chain:          "base-mainnet",
    };
    if (!tokenSpec.name || !tokenSpec.symbol || !tokenSpec.supply)
      throw new Error("token-creator requires params: name, symbol, supply");

    const endpoint = payload?.params?.deployWebhook || WORKFLOW_DEFAULT_WEBHOOK;
    if (!endpoint) throw new Error("token-creator requires deployWebhook or WORKFLOW_DEFAULT_WEBHOOK");

    const result = await doHttpCall({ url: endpoint, method: "POST", body: { user, service: "token-creator", token: tokenSpec } });
    if (!result.ok) throw new Error(`token-creator failed with status ${result.status}`);
    return { service: serviceName, status: result.status, response: result.data };
  }

  if (serviceName === "webhook") {
    if (!payload?.params?.url) throw new Error("payload.params.url required for webhook service");
    const result = await doHttpCall({
      url:     payload.params.url,
      method:  payload?.params?.method || "POST",
      headers: payload?.params?.headers,
      body:    payload?.params?.body ?? { user, params: payload?.params },
    });
    if (!result.ok) throw new Error(`Service webhook failed with status ${result.status}`);
    return { service: serviceName, status: result.status, response: result.data };
  }

  const cfg = serviceMap[serviceName];
  if (!cfg) throw new Error(`Unknown service '${serviceName}'. Configure SERVICE_MAP_JSON or use service='webhook'`);

  const authHeaderValue = cfg.authHeaderEnv ? process.env[cfg.authHeaderEnv] : undefined;
  const headers: Record<string, string> = { ...(cfg.headers || {}), ...(payload?.params?.headers || {}) };
  if (cfg.authHeaderEnv && authHeaderValue) headers.authorization = authHeaderValue;

  const result = await doHttpCall({ url: cfg.url, method: cfg.method || "POST", headers, body: { user, service: serviceName, ...(payload?.params || {}) } });
  if (!result.ok) throw new Error(`Service '${serviceName}' failed with status ${result.status}`);
  return { service: serviceName, status: result.status, response: result.data };
}

// ── session ───────────────────────────────────────────────────────────────────
const sessionConfig: session.SessionOptions = {
  secret:           SESSION_SECRET,
  resave:           false,
  saveUninitialized:false,
  cookie: {
    httpOnly: true,
    secure:   NODE_ENV === "production",
    sameSite: "lax",
    maxAge:   1000 * 60 * 60 * 24,
  },
};

if (REDIS_URL) {
  const redisClient = new Redis(REDIS_URL);
  redisClient.on("error", (err: unknown) => console.error("Redis error", err));
  sessionConfig.store = new RedisStore({ client: redisClient as any, prefix: "spat:sess:" });
}

app.use(session(sessionConfig));

// ── CORS ──────────────────────────────────────────────────────────────────────
if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin",      ALLOWED_ORIGIN);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers",     "Content-Type, X-Payment");
    res.header("Access-Control-Allow-Methods",     "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

// ── rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "too_many_auth_requests" },
});
const usageLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 180,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "too_many_usage_requests" },
});

// ── on-chain helpers ──────────────────────────────────────────────────────────
const usageAbi = ["event Charged(address indexed user, uint8 indexed actionType, uint256 amount, bytes32 requestId)"];
const usageIface = new ethers.Interface(usageAbi);

function requireAuth(req: any, res: any, next: any) {
  if (!req.session?.address) return res.status(401).json({ error: "unauthorized" });
  next();
}

function assertMinUsdValue(action: Action, payload: any) {
  const declaredUsd = Number(payload?.payment?.usdcValue ?? payload?.usdcValue ?? 0);
  const minUsd      = ACTION_POLICIES[action].minUsd;
  if (!Number.isFinite(declaredUsd) || declaredUsd < minUsd)
    throw new Error(`Action '${action}' requires minimum ${minUsd} USDC worth of value`);
}

function assertTaskEventRewardPolicy(payload: any) {
  const rewardUsd = Number(payload?.reward?.usdcValuePerCompletion ?? 0);
  if (!Number.isFinite(rewardUsd) || rewardUsd < 5)
    throw new Error("Task events require reward >= 5 USDC value per completion");
}

async function executeAction(user: string, action: Action, payload: any) {
  const now = new Date().toISOString();
  const db  = await loadDb();

  assertMinUsdValue(action, payload);

  if (action === "makeTask") {
    if (payload?.taskType === "social-growth") assertTaskEventRewardPolicy(payload);
    const task: Task = {
      id:        newId("task"),
      user,
      title:     payload?.title || payload?.eventName || "Untitled Task",
      details:   payload?.details || (
        payload?.taskType === "social-growth"
          ? `Platform=${payload?.platform || "farcaster"}; action=${payload?.socialAction || "follow_or_like_recast"}; target=${payload?.target || ""}`
          : undefined
      ),
      createdAt: now,
    };
    db.tasks.push(task);
    await saveDb(db);
    return { type: "task", id: task.id, data: task };
  }

  if (action === "runWorkflow") {
    const run: WorkflowRun = {
      id:        newId("wf"),
      user,
      name:      payload?.name || "default-workflow",
      input:     payload?.input,
      status:    "running",
      createdAt: now,
      updatedAt: now,
    };
    db.workflowRuns.push(run);
    await saveDb(db);

    try {
      const result  = await runWorkflowIntegration(user, payload);
      const nextDb  = await loadDb();
      const target  = nextDb.workflowRuns.find((r) => r.id === run.id);
      if (target) { target.status = "done"; target.updatedAt = new Date().toISOString(); target.result = result; await saveDb(nextDb); }
      return { type: "workflowRun", id: run.id, data: target || run };
    } catch (error: any) {
      const nextDb = await loadDb();
      const target = nextDb.workflowRuns.find((r) => r.id === run.id);
      if (target) { target.status = "failed"; target.updatedAt = new Date().toISOString(); target.error = String(error?.message || error || "workflow_failed"); await saveDb(nextDb); }
      throw error;
    }
  }

  // useService
  const service: ServiceRun = {
    id:        newId("svc"),
    user,
    service:   payload?.service || "",
    params:    payload?.params,
    status:    "running",
    createdAt: now,
    updatedAt: now,
  };
  db.serviceRuns.push(service);
  await saveDb(db);

  try {
    const output = await runServiceIntegration(user, payload);
    const nextDb = await loadDb();
    const target = nextDb.serviceRuns.find((r) => r.id === service.id);
    if (target) { target.status = "done"; target.updatedAt = new Date().toISOString(); target.output = output; await saveDb(nextDb); }
    return { type: "serviceRun", id: service.id, data: target || service };
  } catch (error: any) {
    const nextDb = await loadDb();
    const target = nextDb.serviceRuns.find((r) => r.id === service.id);
    if (target) { target.status = "failed"; target.updatedAt = new Date().toISOString(); target.error = String(error?.message || error || "service_failed"); await saveDb(nextDb); }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/health", (_req, res) =>
  res.json({
    ok:          true,
    agentWallet: agentWallet?.address || null,
    llm:         !!OPENROUTER_API_KEY,
    mcp:         !!MCP_PORT,
    a2a:         true,
  })
);

// ── Agent wallet info ─────────────────────────────────────────────────────────

/** GET /agent/info – public agent identity card */
app.get("/agent/info", (_req, res) => {
  res.json({
    name:          "SPAT Agent",
    version:       "2.0.0",
    address:       agentWallet?.address || null,
    chainId:       CHAIN_ID,
    spatToken:     SPAT_TOKEN || null,
    treasury:      null, // set after deploy
    usageContract: USAGE_CONTRACT,
    capabilities:  ["llm", "workflow", "token-creator", "social-growth", "mcp", "a2a", "x402"],
  });
});

/** GET /agent/balance – agent's SPAT balance */
app.get("/agent/balance", async (_req, res) => {
  if (!agentWallet) return res.status(503).json({ error: "Agent wallet not configured" });
  if (!SPAT_TOKEN)  return res.status(503).json({ error: "SPAT_TOKEN not configured" });

  try {
    const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
    const token    = new ethers.Contract(SPAT_TOKEN, erc20Abi, provider);
    const [raw, symbol, decimals] = await Promise.all([
      token.balanceOf(agentWallet.address),
      token.symbol(),
      token.decimals(),
    ]);
    const ethBalance = await provider.getBalance(agentWallet.address);
    return res.json({
      address:     agentWallet.address,
      spat:        { raw: raw.toString(), formatted: ethers.formatUnits(raw, decimals), symbol },
      eth:         { raw: ethBalance.toString(), formatted: ethers.formatEther(ethBalance) },
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/** POST /agent/sign – agent signs a message (proves wallet ownership) */
app.post("/agent/sign", requireAuth, async (req: any, res) => {
  if (!agentWallet) return res.status(503).json({ error: "Agent wallet not configured" });
  const { message } = req.body as { message?: string };
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const signature = await agentWallet.signMessage(message);
    return res.json({ ok: true, address: agentWallet.address, signature });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get("/auth/nonce", authLimiter, (req: any, res) => {
  const nonce        = randomBytes(16).toString("hex");
  req.session.nonce  = nonce;
  res.json({ nonce });
});

app.post("/auth/verify", authLimiter, async (req: any, res) => {
  try {
    const { message, signature } = req.body as { message: string | object; signature: string };
    if (!message || !signature || !req.session?.nonce)
      return res.status(400).json({ error: "missing_fields" });

    // BUG FIX: accept both raw string and pre-parsed object from SiweMessage constructor
    const siwe   = new SiweMessage(message as any);
    const result = await siwe.verify({ signature, nonce: req.session.nonce });

    if (!result.success)                                           return res.status(401).json({ error: "invalid_signature" });
    if (Number(siwe.chainId) !== Number(CHAIN_ID))                return res.status(401).json({ error: "wrong_chain" });

    req.session.address         = siwe.address.toLowerCase();
    req.session.nonce           = undefined;
    req.session.authenticatedAt = Date.now();

    return res.json({ ok: true, address: req.session.address });
  } catch {
    return res.status(401).json({ error: "verify_failed" });
  }
});

app.post("/auth/logout", authLimiter, (req: any, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/auth/me", requireAuth, (req: any, res) => {
  res.json({ address: req.session.address, authenticatedAt: req.session.authenticatedAt });
});

// ── Usage ─────────────────────────────────────────────────────────────────────

app.get("/usage/quote", usageLimiter, requireAuth, (_req: any, res) => {
  res.json({ actionCosts, token: SPAT_TOKEN || null, usageContract: USAGE_CONTRACT });
});

app.post("/usage/execute", usageLimiter, requireAuth, async (req: any, res) => {
  try {
    const user = req.session.address as string;
    const { txHash, action, requestId, payload } = req.body as {
      txHash: string; action: Action; requestId: string; payload?: any;
    };

    if (!txHash || !action || !requestId)      return res.status(400).json({ error: "missing_fields" });
    if (!(action in actionTypeMap))             return res.status(400).json({ error: "invalid_action" });

    const expectedActionType = actionTypeMap[action];
    const expectedAmount     = actionCosts[action];

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1)      return res.status(400).json({ error: "tx_not_confirmed" });

    const chargedLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== USAGE_CONTRACT!.toLowerCase()) return false;
      try {
        const parsed = usageIface.parseLog(log);
        if (!parsed || parsed.name !== "Charged") return false;
        return (
          String(parsed.args.user).toLowerCase()       === user &&
          Number(parsed.args.actionType)               === expectedActionType &&
          parsed.args.amount.toString()                === expectedAmount &&
          String(parsed.args.requestId).toLowerCase()  === String(requestId).toLowerCase()
        );
      } catch { return false; }
    });

    if (!chargedLog) return res.status(400).json({ error: "payment_not_verified" });

    const now = new Date().toISOString();
    const db  = await loadDb();

    const duplicate = db.jobs.find((j) => j.requestId.toLowerCase() === String(requestId).toLowerCase());
    if (duplicate)  return res.status(409).json({ error: "request_already_processed", job: duplicate });

    const job: JobRecord = {
      id: newId("job"), requestId, user, action, txHash,
      status: "running", createdAt: now, updatedAt: now,
    };
    db.jobs.push(job);
    await saveDb(db);

    try {
      const result  = await executeAction(user, action, payload);
      const nextDb  = await loadDb();
      const target  = nextDb.jobs.find((j) => j.id === job.id);
      if (target)   { target.status = "done"; target.updatedAt = new Date().toISOString(); target.artifactId = result.id; }
      await saveDb(nextDb);
      return res.json({ ok: true, status: "done", jobId: job.id, result });
    } catch (error: any) {
      const nextDb = await loadDb();
      const target = nextDb.jobs.find((j) => j.id === job.id);
      if (target)  { target.status = "failed"; target.updatedAt = new Date().toISOString(); target.error = String(error?.message || error || "unknown_error"); }
      await saveDb(nextDb);
      return res.status(500).json({ error: "action_execution_failed", jobId: job.id });
    }
  } catch {
    return res.status(500).json({ error: "internal_error" });
  }
});

// ── Jobs / data endpoints ─────────────────────────────────────────────────────

app.get("/jobs",      usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ jobs: db.jobs.filter((j) => j.user === req.session.address) });
});
app.get("/jobs/:id",  usageLimiter, requireAuth, async (req: any, res) => {
  const db   = await loadDb();
  const item = db.jobs.find((j) => j.id === req.params.id && j.user === req.session.address);
  if (!item) return res.status(404).json({ error: "not_found" });
  res.json({ job: item });
});
app.get("/tasks",     usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ tasks: db.tasks.filter((t) => t.user === req.session.address) });
});
app.get("/workflows", usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ workflowRuns: db.workflowRuns.filter((w) => w.user === req.session.address) });
});
app.get("/services",  usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ serviceRuns: db.serviceRuns.filter((s) => s.user === req.session.address) });
});

// ── Catalog ───────────────────────────────────────────────────────────────────

app.get("/catalog/actions", (_req, res) => {
  res.json({
    actions: {
      runWorkflow: {
        description:         "Create web-apps/websites/games on Base via prompt",
        minimumValuePolicy:  "1 USDC worth",
        requiredPayload:     ["payment.usdcValue >= 1", "objective/appType/features"],
      },
      useService: {
        description:         "Create Base tokens (standalone or based on created projects)",
        minimumValuePolicy:  "1 USDC worth",
        services:            ["token-creator", "webhook", "<SERVICE_MAP_JSON names>"],
      },
      makeTask: {
        description:         "Create task events (e.g., Farcaster growth campaigns)",
        minimumValuePolicy:  "1 USDC worth",
        rewardPolicy:        "reward.usdcValuePerCompletion >= 5 for social-growth tasks",
      },
    },
  });
});

// ── LLM endpoints ─────────────────────────────────────────────────────────────

/** GET /llm/status – LLM provider config (public) */
app.get("/llm/status", (_req, res) => {
  res.json({ configured: !!OPENROUTER_API_KEY, provider: "openrouter", baseUrl: LLM_BASE_URL, model: LLM_MODEL });
});

/** POST /llm/chat – authenticated free-form LLM chat */
app.post("/llm/chat", usageLimiter, requireAuth, async (req: any, res) => {
  try {
    const { messages, model, temperature, max_tokens } = req.body as {
      messages:     Array<{ role: "system" | "user" | "assistant"; content: string }>;
      model?:       string;
      temperature?: number;
      max_tokens?:  number;
    };
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "messages array is required" });

    const reply = await callLLM(messages, { model, temperature, max_tokens });
    return res.json({ ok: true, reply, model: model || LLM_MODEL });
  } catch (err: any) {
    console.error("LLM chat error:", err?.message || err);
    return res.status(500).json({ error: "llm_error", detail: String(err?.message || err) });
  }
});

/** POST /llm/assist – natural language → SPAT action payload */
app.post("/llm/assist", usageLimiter, requireAuth, async (req: any, res) => {
  try {
    const { intent } = req.body as { intent: string };
    if (!intent || typeof intent !== "string")
      return res.status(400).json({ error: "intent string is required" });

    const systemPrompt = `You are SPAT Agent, an AI assistant that helps users interact with a
token-powered agent on Base blockchain. Given a plain-English intent from the user, produce a JSON
payload for the correct SPAT action. Supported actions:

- runWorkflow: Build web-apps, websites, or games on Base. Payload fields: action, name, objective, appType, features[], input{}, payment{usdcValue}.
- useService (token-creator): Deploy an ERC-20 token on Base. Payload fields: action, service, params{name,symbol,supply,basedOnProject?}, payment{usdcValue}.
- makeTask (social-growth): Create a Farcaster/social growth campaign. Payload fields: action, taskType, title, platform, socialAction, target, reward{usdcValuePerCompletion}, payment{usdcValue}.

Respond ONLY with a valid JSON object (no markdown fences) that can be sent directly to /usage/execute as the payload.`;

    const reply = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user",   content: intent },
    ]);

    let parsed: unknown;
    try   { parsed = JSON.parse(reply); }
    catch { parsed = { rawReply: reply }; }

    return res.json({ ok: true, suggestion: parsed });
  } catch (err: any) {
    console.error("LLM assist error:", err?.message || err);
    return res.status(500).json({ error: "llm_error", detail: String(err?.message || err) });
  }
});

// ── x402 paid endpoints ───────────────────────────────────────────────────────

/**
 * POST /x402/llm  – pay-per-call LLM via x402 (no SIWE session needed)
 * Clients: AI agents, scripts, CLIs – not browser users.
 * They send `X-Payment: <base64-encoded payment proof>` header.
 */
app.post(
  "/x402/llm",
  usageLimiter,
  x402("500000000000000000", "LLM chat call via SPAT Agent (0.5 SPAT)"),
  async (req: any, res) => {
    try {
      const { messages, model, temperature, max_tokens } = req.body as {
        messages:     Array<{ role: "system" | "user" | "assistant"; content: string }>;
        model?:       string;
        temperature?: number;
        max_tokens?:  number;
      };
      if (!Array.isArray(messages) || messages.length === 0)
        return res.status(400).json({ error: "messages array is required" });

      const reply = await callLLM(messages, { model, temperature, max_tokens });
      res.setHeader("X-Payment-Response", JSON.stringify({ settled: true, payer: req.x402Payer }));
      return res.json({ ok: true, reply, model: model || LLM_MODEL, payer: req.x402Payer });
    } catch (err: any) {
      return res.status(500).json({ error: "llm_error", detail: String(err?.message || err) });
    }
  }
);

/**
 * POST /x402/workflow  – pay-per-call workflow execution via x402
 */
app.post(
  "/x402/workflow",
  usageLimiter,
  x402("3000000000000000000", "Workflow execution via SPAT Agent (3 SPAT)"),
  async (req: any, res) => {
    try {
      const payload = req.body;
      if (!payload) return res.status(400).json({ error: "payload required" });
      const result = await runWorkflowIntegration(req.x402Payer || "x402", payload);
      res.setHeader("X-Payment-Response", JSON.stringify({ settled: true, payer: req.x402Payer }));
      return res.json({ ok: true, result, payer: req.x402Payer });
    } catch (err: any) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

// ── A2A endpoints ─────────────────────────────────────────────────────────────

/** GET /.well-known/agent.json – A2A agent discovery card */
app.get("/.well-known/agent.json", (_req, res) => {
  res.json(buildAgentCard());
});

/** GET /a2a/agents – list of known peer agents */
app.get("/a2a/agents", (_req, res) => {
  res.json({ agents: Array.from(peerAgents.values()) });
});

/** POST /a2a/agents/discover – discover + cache a peer agent card */
app.post("/a2a/agents/discover", requireAuth, async (req: any, res) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: "url required" });
  const card = await fetchAgentCard(url);
  if (!card) return res.status(502).json({ error: "Could not reach agent at that URL" });
  return res.json({ ok: true, agent: peerAgents.get(url) });
});

/** POST /a2a/agents/call – call a peer agent skill */
app.post("/a2a/agents/call", usageLimiter, requireAuth, async (req: any, res) => {
  const { url, skill, message, paymentHeader } = req.body as {
    url: string; skill: string; message: string; paymentHeader?: string;
  };
  if (!url || !skill || !message)
    return res.status(400).json({ error: "url, skill, message required" });

  try {
    const task = await sendA2ATask(url, skill, message, paymentHeader);
    return res.json({ ok: true, task });
  } catch (err: any) {
    if ((err as any).paymentRequired) {
      return res.status(402).json({ error: "peer_payment_required", accepts: (err as any).paymentRequired });
    }
    return res.status(502).json({ error: "a2a_call_failed", detail: String(err?.message || err) });
  }
});

/**
 * POST /a2a  – receive A2A tasks FROM other agents (JSON-RPC 2.0)
 * This is where peer agents call us. Implements the A2A `tasks/send` method.
 */
app.post("/a2a", usageLimiter, async (req: any, res) => {
  const { jsonrpc, id, method, params } = req.body as {
    jsonrpc: string; id: string; method: string; params: any;
  };

  if (jsonrpc !== "2.0" || !method)
    return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });

  if (method !== "tasks/send")
    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method '${method}' not supported` } });

  const taskId    = params?.id        || newId("a2a");
  const sessionId = params?.sessionId || newId("sess");
  const message   = params?.message   as A2AMessage | undefined;
  const skill     = params?.metadata?.skill as string | undefined;

  if (!message?.parts?.length)
    return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "message.parts required" } });

  const text = message.parts.find((p) => p.type === "text")?.text || "";

  try {
    let replyText = "";

    if (skill === "llm_chat" || !skill) {
      // Route to LLM
      replyText = await callLLM([
        { role: "system",  content: "You are SPAT Agent, a token-powered AI agent on Base blockchain. Answer helpfully and concisely." },
        { role: "user",    content: text },
      ]);
    } else if (skill === "build_app") {
      replyText = await callLLM([
        { role: "system",  content: "You are SPAT Agent's app-builder skill. Given a request, return a runWorkflow payload JSON for building a Base web3 app." },
        { role: "user",    content: text },
      ]);
    } else if (skill === "create_token") {
      replyText = await callLLM([
        { role: "system",  content: "You are SPAT Agent's token-creator skill. Given a request, return a useService token-creator payload JSON." },
        { role: "user",    content: text },
      ]);
    } else if (skill === "social_growth_campaign") {
      replyText = await callLLM([
        { role: "system",  content: "You are SPAT Agent's social growth skill. Return a makeTask social-growth payload JSON." },
        { role: "user",    content: text },
      ]);
    } else {
      replyText = `Unknown skill '${skill}'. Available: llm_chat, build_app, create_token, social_growth_campaign`;
    }

    const task: A2ATask = {
      id:      taskId,
      sessionId,
      status:  {
        state:   "completed",
        message: {
          role:  "agent",
          parts: [{ type: "text", text: replyText }],
        },
      },
      history: [message, { role: "agent", parts: [{ type: "text", text: replyText }] }],
    };

    return res.json({ jsonrpc: "2.0", id, result: task });
  } catch (err: any) {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        id: taskId, sessionId,
        status: { state: "failed", message: { role: "agent", parts: [{ type: "text", text: String(err?.message || err) }] } },
      } as A2ATask,
    });
  }
});

// ── MCP (Model Context Protocol) server ───────────────────────────────────────
// Exposes SPAT Agent capabilities as MCP tools that Claude / any MCP-client can call.

const MCP_TOOLS = [
  {
    name:        "spat_llm_chat",
    description: "Send messages to SPAT Agent's LLM (OpenRouter). Returns AI response.",
    inputSchema: {
      type:     "object",
      properties: {
        messages: { type: "array",  description: "Array of {role, content} chat messages" },
        model:    { type: "string", description: "Optional model override (e.g. openai/gpt-4o)" },
      },
      required: ["messages"],
    },
  },
  {
    name:        "spat_build_app",
    description: "Build a web3 app/website/game on Base via SPAT Agent workflow.",
    inputSchema: {
      type:     "object",
      properties: {
        objective: { type: "string", description: "What to build (e.g. 'social prediction game')" },
        appType:   { type: "string", enum: ["web-app", "website", "game"] },
        features:  { type: "array",  items: { type: "string" }, description: "Feature list" },
      },
      required: ["objective"],
    },
  },
  {
    name:        "spat_create_token",
    description: "Deploy an ERC-20 token on Base via SPAT Agent.",
    inputSchema: {
      type:     "object",
      properties: {
        name:   { type: "string", description: "Token name" },
        symbol: { type: "string", description: "Token ticker symbol" },
        supply: { type: "string", description: "Total supply in wei (e.g. 1000000000000000000000000)" },
      },
      required: ["name", "symbol", "supply"],
    },
  },
  {
    name:        "spat_social_growth",
    description: "Create a Farcaster social growth campaign with on-chain rewards.",
    inputSchema: {
      type:     "object",
      properties: {
        title:        { type: "string" },
        platform:     { type: "string", default: "farcaster" },
        socialAction: { type: "string", default: "follow_like_recast" },
        target:       { type: "string", description: "Profile/URL to target" },
        rewardUsd:    { type: "number", description: "Reward per completion in USD (min 5)" },
      },
      required: ["title", "target"],
    },
  },
  {
    name:        "spat_agent_info",
    description: "Get SPAT Agent info: wallet address, capabilities, on-chain contracts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name:        "spat_a2a_call",
    description: "Call a peer A2A agent by URL.",
    inputSchema: {
      type:     "object",
      properties: {
        url:     { type: "string", description: "Peer agent A2A endpoint URL" },
        skill:   { type: "string", description: "Skill ID to invoke" },
        message: { type: "string", description: "Message to send" },
      },
      required: ["url", "message"],
    },
  },
];

const mcpApp = express();
mcpApp.use(express.json({ limit: "2mb" }));

// MCP JSON-RPC 2.0 endpoint
mcpApp.post("/", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body as {
    jsonrpc: string; id: string | number; method: string; params?: any;
  };

  if (jsonrpc !== "2.0")
    return res.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });

  try {
    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities:    { tools: {}, resources: {} },
          serverInfo:      { name: "spat-agent-mcp", version: "2.0.0" },
        },
      });
    }

    if (method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    }

    if (method === "tools/call") {
      const { name: toolName, arguments: args } = params as { name: string; arguments: Record<string, any> };
      let content: Array<{ type: string; text: string }> = [];

      if (toolName === "spat_llm_chat") {
        const reply = await callLLM(args.messages, { model: args.model });
        content = [{ type: "text", text: reply }];

      } else if (toolName === "spat_build_app") {
        const prompt = `Build a ${args.appType || "web-app"} on Base: ${args.objective}. Features: ${(args.features || []).join(", ")}`;
        const reply  = await callLLM([
          { role: "system", content: "You are a Base blockchain app builder. Return a detailed technical spec JSON." },
          { role: "user",   content: prompt },
        ]);
        content = [{ type: "text", text: reply }];

      } else if (toolName === "spat_create_token") {
        content = [{
          type: "text",
          text: JSON.stringify({
            action:  "useService",
            service: "token-creator",
            params:  { name: args.name, symbol: args.symbol, supply: args.supply },
            payment: { usdcValue: 1 },
          }, null, 2),
        }];

      } else if (toolName === "spat_social_growth") {
        content = [{
          type: "text",
          text: JSON.stringify({
            action:       "makeTask",
            taskType:     "social-growth",
            title:        args.title,
            platform:     args.platform || "farcaster",
            socialAction: args.socialAction || "follow_like_recast",
            target:       args.target,
            reward:       { usdcValuePerCompletion: args.rewardUsd || 5 },
            payment:      { usdcValue: 1 },
          }, null, 2),
        }];

      } else if (toolName === "spat_agent_info") {
        content = [{
          type: "text",
          text: JSON.stringify({
            name:          "SPAT Agent",
            address:       agentWallet?.address || null,
            chainId:       CHAIN_ID,
            spatToken:     SPAT_TOKEN,
            usageContract: USAGE_CONTRACT,
            capabilities:  ["llm", "workflow", "token-creator", "social-growth", "mcp", "a2a", "x402"],
            llm:           { provider: "openrouter", model: LLM_MODEL },
          }, null, 2),
        }];

      } else if (toolName === "spat_a2a_call") {
        const task = await sendA2ATask(args.url, args.skill || "llm_chat", args.message);
        content = [{ type: "text", text: JSON.stringify(task, null, 2) }];

      } else {
        return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool '${toolName}'` } });
      }

      return res.json({ jsonrpc: "2.0", id, result: { content, isError: false } });
    }

    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method '${method}' not found` } });
  } catch (e: any) {
    return res.json({
      jsonrpc: "2.0", id,
      result:  { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true },
    });
  }
});

// MCP SSE endpoint (for streaming-capable clients)
mcpApp.get("/sse", (_req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const card = buildAgentCard();
  res.write(`data: ${JSON.stringify({ type: "agent_card", card })}\n\n`);

  // Heartbeat every 15s
  const hb = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  res.on("close", () => clearInterval(hb));
});

// MCP well-known
mcpApp.get("/.well-known/mcp.json", (_req, res) => {
  res.json({
    name:    "spat-agent-mcp",
    version: "2.0.0",
    endpoint: `http://localhost:${MCP_PORT || 8788}`,
    tools:   MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
  });
});

// ── start ─────────────────────────────────────────────────────────────────────
const mainPort = Number(PORT || 8787);
app.listen(mainPort, () => {
  console.log(`[main]  SPAT Agent backend  → http://localhost:${mainPort}`);
  console.log(`[main]  A2A endpoint         → http://localhost:${mainPort}/a2a`);
  console.log(`[main]  A2A discovery card   → http://localhost:${mainPort}/.well-known/agent.json`);
});

const mcpPort = Number(MCP_PORT || 8788);
mcpApp.listen(mcpPort, () => {
  console.log(`[mcp]   MCP server           → http://localhost:${mcpPort}`);
  console.log(`[mcp]   MCP well-known       → http://localhost:${mcpPort}/.well-known/mcp.json`);
  console.log(`[mcp]   MCP SSE stream       → http://localhost:${mcpPort}/sse`);
  console.log(`[mcp]   Tools: ${MCP_TOOLS.map((t) => t.name).join(", ")}`);
});
