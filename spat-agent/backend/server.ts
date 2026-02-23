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
  SERVICE_MAP_JSON
} = process.env;

if (!SESSION_SECRET) throw new Error("SESSION_SECRET is required");
if (!CHAIN_ID) throw new Error("CHAIN_ID is required");
if (!RPC_URL) throw new Error("RPC_URL is required");
if (!USAGE_CONTRACT) throw new Error("USAGE_CONTRACT is required");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const timeoutMs = Number(REQUEST_TIMEOUT_MS || 20000);

type JobStatus = "queued" | "running" | "done" | "failed";
type Action = "makeTask" | "runWorkflow" | "useService";

type Task = {
  id: string;
  user: string;
  title: string;
  details?: string;
  createdAt: string;
};

type WorkflowRun = {
  id: string;
  user: string;
  name: string;
  input?: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown>;
};

type ServiceRun = {
  id: string;
  user: string;
  service: string;
  params?: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  output?: Record<string, unknown>;
};

type JobRecord = {
  id: string;
  requestId: string;
  user: string;
  action: Action;
  txHash: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  artifactId?: string;
  error?: string;
};

type RuntimeDB = {
  tasks: Task[];
  workflowRuns: WorkflowRun[];
  serviceRuns: ServiceRun[];
  jobs: JobRecord[];
};

type HttpCallInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type WorkflowStep = {
  type: "webhook" | "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type ServiceConfig = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  authHeaderEnv?: string;
};


type ActionPolicy = {
  minUsd: number;
  description: string;
};

const ACTION_POLICIES: Record<Action, ActionPolicy> = {
  makeTask: { minUsd: 1, description: "Create task events" },
  runWorkflow: { minUsd: 1, description: "Build/deploy web apps, websites, games on Base" },
  useService: { minUsd: 1, description: "Create tokens on Base / specialized services" }
};


const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "runtime-db.json");

const defaultDb: RuntimeDB = {
  tasks: [],
  workflowRuns: [],
  serviceRuns: [],
  jobs: []
};

const serviceMap: Record<string, ServiceConfig> = (() => {
  if (!SERVICE_MAP_JSON) return {};
  try {
    return JSON.parse(SERVICE_MAP_JSON);
  } catch {
    console.warn("Invalid SERVICE_MAP_JSON, ignoring");
    return {};
  }
})();

async function loadDb(): Promise<RuntimeDB> {
  await mkdir(dataDir, { recursive: true });
  try {
    const raw = await readFile(dbPath, "utf8");
    const parsed = JSON.parse(raw) as RuntimeDB;
    return {
      tasks: parsed.tasks || [],
      workflowRuns: parsed.workflowRuns || [],
      serviceRuns: parsed.serviceRuns || [],
      jobs: parsed.jobs || []
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

async function doHttpCall(input: HttpCallInput) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(input.url, {
      method: input.method || "POST",
      headers: {
        "content-type": "application/json",
        ...(input.headers || {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep as text
    }

    return {
      ok: res.ok,
      status: res.status,
      data: parsed
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runWorkflowIntegration(user: string, payload: any) {
  const runName = payload?.name || "base-app-builder";
  const steps = (payload?.steps || []) as WorkflowStep[];

  const effectiveSteps =
    steps.length > 0
      ? steps
      : WORKFLOW_DEFAULT_WEBHOOK
      ? [
          {
            type: "webhook" as const,
            url: WORKFLOW_DEFAULT_WEBHOOK,
            method: "POST",
            body: {
              user,
              workflow: runName,
              objective: payload?.objective || "create_web3_app",
              appType: payload?.appType || "web-app",
              features: payload?.features || [],
              chain: "base-mainnet",
              input: payload?.input || {},
              timestamp: new Date().toISOString()
            }
          }
        ]
      : [];

  if (effectiveSteps.length === 0) {
    throw new Error("No workflow steps provided and WORKFLOW_DEFAULT_WEBHOOK not configured");
  }

  const stepResults: Array<Record<string, unknown>> = [];

  for (const [index, step] of effectiveSteps.entries()) {
    const result = await doHttpCall({
      url: step.url,
      method: step.method || "POST",
      headers: step.headers,
      body:
        step.body ?? {
          user,
          workflow: runName,
          input: payload?.input || {},
          step: index + 1
        }
    });

    stepResults.push({
      step: index + 1,
      url: step.url,
      status: result.status,
      ok: result.ok,
      response: result.data
    });

    if (!result.ok) {
      throw new Error(`Workflow step ${index + 1} failed with status ${result.status}`);
    }
  }

  return {
    summary: `Workflow ${runName} executed`,
    stepsExecuted: effectiveSteps.length,
    stepResults
  };
}

async function runServiceIntegration(user: string, payload: any) {
  const serviceName = String(payload?.service || "").trim();
  if (!serviceName) throw new Error("payload.service is required for useService");

  if (serviceName === "token-creator") {
    const tokenSpec = {
      name: payload?.params?.name,
      symbol: payload?.params?.symbol,
      supply: payload?.params?.supply,
      basedOnProject: payload?.params?.basedOnProject || null,
      chain: "base-mainnet"
    };
    if (!tokenSpec.name || !tokenSpec.symbol || !tokenSpec.supply) {
      throw new Error("token-creator requires params: name, symbol, supply");
    }

    const endpoint = payload?.params?.deployWebhook || WORKFLOW_DEFAULT_WEBHOOK;
    if (!endpoint) {
      throw new Error("token-creator requires deployWebhook or WORKFLOW_DEFAULT_WEBHOOK");
    }

    const result = await doHttpCall({
      url: endpoint,
      method: "POST",
      body: {
        user,
        service: "token-creator",
        token: tokenSpec
      }
    });

    if (!result.ok) throw new Error(`token-creator failed with status ${result.status}`);

    return {
      service: serviceName,
      status: result.status,
      response: result.data
    };
  }

  if (serviceName === "webhook") {
    if (!payload?.params?.url) throw new Error("payload.params.url is required for webhook service");
    const result = await doHttpCall({
      url: payload.params.url,
      method: payload?.params?.method || "POST",
      headers: payload?.params?.headers,
      body: payload?.params?.body ?? { user, params: payload?.params }
    });

    if (!result.ok) throw new Error(`Service webhook failed with status ${result.status}`);

    return {
      service: serviceName,
      status: result.status,
      response: result.data
    };
  }

  const cfg = serviceMap[serviceName];
  if (!cfg) {
    throw new Error(`Unknown service '${serviceName}'. Configure SERVICE_MAP_JSON or use service='webhook'`);
  }

  const authHeaderValue = cfg.authHeaderEnv ? process.env[cfg.authHeaderEnv] : undefined;
  const headers: Record<string, string> = {
    ...(cfg.headers || {}),
    ...(payload?.params?.headers || {})
  };

  if (cfg.authHeaderEnv && authHeaderValue) {
    headers.authorization = authHeaderValue;
  }

  const result = await doHttpCall({
    url: cfg.url,
    method: cfg.method || "POST",
    headers,
    body: {
      user,
      service: serviceName,
      ...(payload?.params || {})
    }
  });

  if (!result.ok) throw new Error(`Service '${serviceName}' failed with status ${result.status}`);

  return {
    service: serviceName,
    status: result.status,
    response: result.data
  };
}

const sessionConfig: session.SessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24
  }
};

if (REDIS_URL) {
  const redisClient = new Redis(REDIS_URL);
  redisClient.on("error", (err: unknown) => {
    console.error("Redis error", err);
  });
  sessionConfig.store = new RedisStore({ client: redisClient as any, prefix: "spat:sess:" });
}

app.use(session(sessionConfig));

if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_auth_requests" }
});

const usageLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_usage_requests" }
});

const usageAbi = ["event Charged(address indexed user, uint8 indexed actionType, uint256 amount, bytes32 requestId)"];
const usageIface = new ethers.Interface(usageAbi);

const actionCosts: Record<Action, string> = {
  makeTask: "1000000000000000000",
  runWorkflow: "3000000000000000000",
  useService: "500000000000000000"
};

const actionTypeMap: Record<Action, number> = {
  makeTask: 0,
  runWorkflow: 1,
  useService: 2
};

function requireAuth(req: any, res: any, next: any) {
  if (!req.session?.address) return res.status(401).json({ error: "unauthorized" });
  next();
}


function assertMinUsdValue(action: Action, payload: any) {
  const declaredUsd = Number(payload?.payment?.usdcValue ?? payload?.usdcValue ?? 0);
  const minUsd = ACTION_POLICIES[action].minUsd;
  if (!Number.isFinite(declaredUsd) || declaredUsd < minUsd) {
    throw new Error(`Action '${action}' requires minimum ${minUsd} USDC worth of value`);
  }
}

function assertTaskEventRewardPolicy(payload: any) {
  const rewardUsd = Number(payload?.reward?.usdcValuePerCompletion ?? 0);
  if (!Number.isFinite(rewardUsd) || rewardUsd < 5) {
    throw new Error("Task events require reward >= 5 USDC value per completion");
  }
}

async function executeAction(user: string, action: Action, payload: any) {
  const now = new Date().toISOString();
  const db = await loadDb();

  assertMinUsdValue(action, payload);

  if (action === "makeTask") {
    if (payload?.taskType === "social-growth") {
      assertTaskEventRewardPolicy(payload);
    }

    const task: Task = {
      id: newId("task"),
      user,
      title: payload?.title || payload?.eventName || "Untitled Task",
      details:
        payload?.details ||
        (payload?.taskType === "social-growth"
          ? `Platform=${payload?.platform || "farcaster"}; action=${payload?.socialAction || "follow_or_like_recast"}; target=${payload?.target || ""}`
          : undefined),
      createdAt: now
    };
    db.tasks.push(task);
    await saveDb(db);
    return { type: "task", id: task.id, data: task };
  }

  if (action === "runWorkflow") {
    const run: WorkflowRun = {
      id: newId("wf"),
      user,
      name: payload?.name || "default-workflow",
      input: payload?.input,
      status: "running",
      createdAt: now,
      updatedAt: now
    };
    db.workflowRuns.push(run);
    await saveDb(db);

    const result = await runWorkflowIntegration(user, payload);

    const nextDb = await loadDb();
    const target = nextDb.workflowRuns.find((r) => r.id === run.id);
    if (target) {
      target.status = "done";
      target.updatedAt = new Date().toISOString();
      target.result = result;
      await saveDb(nextDb);
    }

    return { type: "workflowRun", id: run.id, data: target || run };
  }

  const service: ServiceRun = {
    id: newId("svc"),
    user,
    service: payload?.service || "",
    params: payload?.params,
    status: "running",
    createdAt: now,
    updatedAt: now
  };
  db.serviceRuns.push(service);
  await saveDb(db);

  const output = await runServiceIntegration(user, payload);

  const nextDb = await loadDb();
  const target = nextDb.serviceRuns.find((r) => r.id === service.id);
  if (target) {
    target.status = "done";
    target.updatedAt = new Date().toISOString();
    target.output = output;
    await saveDb(nextDb);
  }

  return { type: "serviceRun", id: service.id, data: target || service };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/auth/nonce", authLimiter, (req: any, res) => {
  const nonce = randomBytes(16).toString("hex");
  req.session.nonce = nonce;
  res.json({ nonce });
});

app.post("/auth/verify", authLimiter, async (req: any, res) => {
  try {
    const { message, signature } = req.body;
    if (!message || !signature || !req.session?.nonce) return res.status(400).json({ error: "missing_fields" });

    const siwe = new SiweMessage(message);
    const result = await siwe.verify({ signature, nonce: req.session.nonce });

    if (!result.success) return res.status(401).json({ error: "invalid_signature" });
    if (Number(siwe.chainId) !== Number(CHAIN_ID)) return res.status(401).json({ error: "wrong_chain" });

    req.session.address = siwe.address.toLowerCase();
    req.session.nonce = undefined;
    req.session.authenticatedAt = Date.now();

    return res.json({ ok: true, address: req.session.address });
  } catch {
    return res.status(401).json({ error: "verify_failed" });
  }
});

app.post("/auth/logout", authLimiter, (req: any, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/usage/quote", usageLimiter, requireAuth, (_req: any, res) => {
  res.json({ actionCosts, token: SPAT_TOKEN || null, usageContract: USAGE_CONTRACT });
});

app.post("/usage/execute", usageLimiter, requireAuth, async (req: any, res) => {
  try {
    const user = req.session.address as string;
    const { txHash, action, requestId, payload } = req.body as {
      txHash: string;
      action: Action;
      requestId: string;
      payload?: any;
    };

    if (!txHash || !action || !requestId) return res.status(400).json({ error: "missing_fields" });
    if (!(action in actionTypeMap)) return res.status(400).json({ error: "invalid_action" });

    const expectedActionType = actionTypeMap[action];
    const expectedAmount = actionCosts[action];

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return res.status(400).json({ error: "tx_not_confirmed" });

    const chargedLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== USAGE_CONTRACT.toLowerCase()) return false;
      try {
        const parsed = usageIface.parseLog(log);
        if (!parsed || parsed.name !== "Charged") return false;

        const evtUser = String(parsed.args.user).toLowerCase();
        const actionType = Number(parsed.args.actionType);
        const amount = parsed.args.amount.toString();
        const rid = String(parsed.args.requestId).toLowerCase();

        return (
          evtUser === user &&
          actionType === expectedActionType &&
          amount === expectedAmount &&
          rid === String(requestId).toLowerCase()
        );
      } catch {
        return false;
      }
    });

    if (!chargedLog) return res.status(400).json({ error: "payment_not_verified" });

    const now = new Date().toISOString();
    const db = await loadDb();

    const duplicate = db.jobs.find((j) => j.requestId.toLowerCase() === String(requestId).toLowerCase());
    if (duplicate) return res.status(409).json({ error: "request_already_processed", job: duplicate });

    const job: JobRecord = {
      id: newId("job"),
      requestId,
      user,
      action,
      txHash,
      status: "running",
      createdAt: now,
      updatedAt: now
    };
    db.jobs.push(job);
    await saveDb(db);

    try {
      const result = await executeAction(user, action, payload);
      const nextDb = await loadDb();
      const target = nextDb.jobs.find((j) => j.id === job.id);
      if (target) {
        target.status = "done";
        target.updatedAt = new Date().toISOString();
        target.artifactId = result.id;
      }
      await saveDb(nextDb);

      return res.json({ ok: true, status: "done", jobId: job.id, result });
    } catch (error: any) {
      const nextDb = await loadDb();
      const target = nextDb.jobs.find((j) => j.id === job.id);
      if (target) {
        target.status = "failed";
        target.updatedAt = new Date().toISOString();
        target.error = String(error?.message || error || "unknown_error");
      }
      await saveDb(nextDb);
      return res.status(500).json({ error: "action_execution_failed", jobId: job.id });
    }
  } catch {
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/jobs", usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  const items = db.jobs.filter((j) => j.user === req.session.address);
  res.json({ jobs: items });
});

app.get("/jobs/:id", usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  const item = db.jobs.find((j) => j.id === req.params.id && j.user === req.session.address);
  if (!item) return res.status(404).json({ error: "not_found" });
  res.json({ job: item });
});

app.get("/tasks", usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ tasks: db.tasks.filter((t) => t.user === req.session.address) });
});

app.get("/workflows", usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ workflowRuns: db.workflowRuns.filter((w) => w.user === req.session.address) });
});

app.get("/services", usageLimiter, requireAuth, async (req: any, res) => {
  const db = await loadDb();
  res.json({ serviceRuns: db.serviceRuns.filter((s) => s.user === req.session.address) });
});

app.get("/catalog/actions", (_req, res) => {
  res.json({
    actions: {
      runWorkflow: {
        description: "Create web-apps/websites/games on Base via prompt",
        minimumValuePolicy: "1 USDC worth",
        requiredPayload: ["payment.usdcValue >= 1", "objective/appType/features"]
      },
      useService: {
        description: "Create Base tokens (standalone or based on created projects)",
        minimumValuePolicy: "1 USDC worth",
        services: ["token-creator", "webhook", "<SERVICE_MAP_JSON names>"]
      },
      makeTask: {
        description: "Create task events (e.g., Farcaster growth campaigns)",
        minimumValuePolicy: "1 USDC worth",
        rewardPolicy: "reward.usdcValuePerCompletion >= 5 for social-growth tasks"
      }
    }
  });
});

app.listen(Number(PORT || 8787), () => {
  console.log(`SPAT Agent backend listening on :${PORT || 8787}`);
});
