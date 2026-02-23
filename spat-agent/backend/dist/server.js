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
const { SESSION_SECRET, NODE_ENV, CHAIN_ID, RPC_URL, USAGE_CONTRACT, SPAT_TOKEN, ALLOWED_ORIGIN, REDIS_URL, PORT, REQUEST_TIMEOUT_MS, WORKFLOW_DEFAULT_WEBHOOK, SERVICE_MAP_JSON } = process.env;
if (!SESSION_SECRET)
    throw new Error("SESSION_SECRET is required");
if (!CHAIN_ID)
    throw new Error("CHAIN_ID is required");
if (!RPC_URL)
    throw new Error("RPC_URL is required");
if (!USAGE_CONTRACT)
    throw new Error("USAGE_CONTRACT is required");
const provider = new ethers.JsonRpcProvider(RPC_URL);
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
const timeoutMs = Number(REQUEST_TIMEOUT_MS || 20000);
const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "runtime-db.json");
const defaultDb = {
    tasks: [],
    workflowRuns: [],
    serviceRuns: [],
    jobs: []
};
const serviceMap = (() => {
    if (!SERVICE_MAP_JSON)
        return {};
    try {
        return JSON.parse(SERVICE_MAP_JSON);
    }
    catch {
        console.warn("Invalid SERVICE_MAP_JSON, ignoring");
        return {};
    }
})();
async function loadDb() {
    await mkdir(dataDir, { recursive: true });
    try {
        const raw = await readFile(dbPath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            tasks: parsed.tasks || [],
            workflowRuns: parsed.workflowRuns || [],
            serviceRuns: parsed.serviceRuns || [],
            jobs: parsed.jobs || []
        };
    }
    catch {
        await writeFile(dbPath, JSON.stringify(defaultDb, null, 2));
        return structuredClone(defaultDb);
    }
}
async function saveDb(db) {
    await writeFile(dbPath, JSON.stringify(db, null, 2));
}
function newId(prefix) {
    return `${prefix}_${randomBytes(8).toString("hex")}`;
}
async function doHttpCall(input) {
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
        let parsed = text;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            // keep as text
        }
        return {
            ok: res.ok,
            status: res.status,
            data: parsed
        };
    }
    finally {
        clearTimeout(timer);
    }
}
async function runWorkflowIntegration(user, payload) {
    const runName = payload?.name || "default-workflow";
    const steps = (payload?.steps || []);
    const effectiveSteps = steps.length > 0
        ? steps
        : WORKFLOW_DEFAULT_WEBHOOK
            ? [
                {
                    type: "webhook",
                    url: WORKFLOW_DEFAULT_WEBHOOK,
                    method: "POST",
                    body: {
                        user,
                        workflow: runName,
                        input: payload?.input || {},
                        timestamp: new Date().toISOString()
                    }
                }
            ]
            : [];
    if (effectiveSteps.length === 0) {
        throw new Error("No workflow steps provided and WORKFLOW_DEFAULT_WEBHOOK not configured");
    }
    const stepResults = [];
    for (const [index, step] of effectiveSteps.entries()) {
        const result = await doHttpCall({
            url: step.url,
            method: step.method || "POST",
            headers: step.headers,
            body: step.body ?? {
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
async function runServiceIntegration(user, payload) {
    const serviceName = String(payload?.service || "").trim();
    if (!serviceName)
        throw new Error("payload.service is required for useService");
    if (serviceName === "webhook") {
        if (!payload?.params?.url)
            throw new Error("payload.params.url is required for webhook service");
        const result = await doHttpCall({
            url: payload.params.url,
            method: payload?.params?.method || "POST",
            headers: payload?.params?.headers,
            body: payload?.params?.body ?? { user, params: payload?.params }
        });
        if (!result.ok)
            throw new Error(`Service webhook failed with status ${result.status}`);
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
    const headers = {
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
    if (!result.ok)
        throw new Error(`Service '${serviceName}' failed with status ${result.status}`);
    return {
        service: serviceName,
        status: result.status,
        response: result.data
    };
}
const sessionConfig = {
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
    redisClient.on("error", (err) => {
        console.error("Redis error", err);
    });
    sessionConfig.store = new RedisStore({ client: redisClient, prefix: "spat:sess:" });
}
app.use(session(sessionConfig));
if (ALLOWED_ORIGIN) {
    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
        res.header("Access-Control-Allow-Credentials", "true");
        res.header("Access-Control-Allow-Headers", "Content-Type");
        res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        if (req.method === "OPTIONS")
            return res.sendStatus(204);
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
const actionCosts = {
    makeTask: "1000000000000000000",
    runWorkflow: "3000000000000000000",
    useService: "500000000000000000"
};
const actionTypeMap = {
    makeTask: 0,
    runWorkflow: 1,
    useService: 2
};
function requireAuth(req, res, next) {
    if (!req.session?.address)
        return res.status(401).json({ error: "unauthorized" });
    next();
}
async function executeAction(user, action, payload) {
    const now = new Date().toISOString();
    const db = await loadDb();
    if (action === "makeTask") {
        const task = {
            id: newId("task"),
            user,
            title: payload?.title || "Untitled Task",
            details: payload?.details,
            createdAt: now
        };
        db.tasks.push(task);
        await saveDb(db);
        return { type: "task", id: task.id, data: task };
    }
    if (action === "runWorkflow") {
        const run = {
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
    const service = {
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
app.get("/auth/nonce", authLimiter, (req, res) => {
    const nonce = randomBytes(16).toString("hex");
    req.session.nonce = nonce;
    res.json({ nonce });
});
app.post("/auth/verify", authLimiter, async (req, res) => {
    try {
        const { message, signature } = req.body;
        if (!message || !signature || !req.session?.nonce)
            return res.status(400).json({ error: "missing_fields" });
        const siwe = new SiweMessage(message);
        const result = await siwe.verify({ signature, nonce: req.session.nonce });
        if (!result.success)
            return res.status(401).json({ error: "invalid_signature" });
        if (Number(siwe.chainId) !== Number(CHAIN_ID))
            return res.status(401).json({ error: "wrong_chain" });
        req.session.address = siwe.address.toLowerCase();
        req.session.nonce = undefined;
        req.session.authenticatedAt = Date.now();
        return res.json({ ok: true, address: req.session.address });
    }
    catch {
        return res.status(401).json({ error: "verify_failed" });
    }
});
app.post("/auth/logout", authLimiter, (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});
app.get("/usage/quote", usageLimiter, requireAuth, (_req, res) => {
    res.json({ actionCosts, token: SPAT_TOKEN || null, usageContract: USAGE_CONTRACT });
});
app.post("/usage/execute", usageLimiter, requireAuth, async (req, res) => {
    try {
        const user = req.session.address;
        const { txHash, action, requestId, payload } = req.body;
        if (!txHash || !action || !requestId)
            return res.status(400).json({ error: "missing_fields" });
        if (!(action in actionTypeMap))
            return res.status(400).json({ error: "invalid_action" });
        const expectedActionType = actionTypeMap[action];
        const expectedAmount = actionCosts[action];
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1)
            return res.status(400).json({ error: "tx_not_confirmed" });
        const chargedLog = receipt.logs.find((log) => {
            if (log.address.toLowerCase() !== USAGE_CONTRACT.toLowerCase())
                return false;
            try {
                const parsed = usageIface.parseLog(log);
                if (!parsed || parsed.name !== "Charged")
                    return false;
                const evtUser = String(parsed.args.user).toLowerCase();
                const actionType = Number(parsed.args.actionType);
                const amount = parsed.args.amount.toString();
                const rid = String(parsed.args.requestId).toLowerCase();
                return (evtUser === user &&
                    actionType === expectedActionType &&
                    amount === expectedAmount &&
                    rid === String(requestId).toLowerCase());
            }
            catch {
                return false;
            }
        });
        if (!chargedLog)
            return res.status(400).json({ error: "payment_not_verified" });
        const now = new Date().toISOString();
        const db = await loadDb();
        const duplicate = db.jobs.find((j) => j.requestId.toLowerCase() === String(requestId).toLowerCase());
        if (duplicate)
            return res.status(409).json({ error: "request_already_processed", job: duplicate });
        const job = {
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
        }
        catch (error) {
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
    }
    catch {
        return res.status(500).json({ error: "internal_error" });
    }
});
app.get("/jobs", usageLimiter, requireAuth, async (req, res) => {
    const db = await loadDb();
    const items = db.jobs.filter((j) => j.user === req.session.address);
    res.json({ jobs: items });
});
app.get("/jobs/:id", usageLimiter, requireAuth, async (req, res) => {
    const db = await loadDb();
    const item = db.jobs.find((j) => j.id === req.params.id && j.user === req.session.address);
    if (!item)
        return res.status(404).json({ error: "not_found" });
    res.json({ job: item });
});
app.get("/tasks", usageLimiter, requireAuth, async (req, res) => {
    const db = await loadDb();
    res.json({ tasks: db.tasks.filter((t) => t.user === req.session.address) });
});
app.get("/workflows", usageLimiter, requireAuth, async (req, res) => {
    const db = await loadDb();
    res.json({ workflowRuns: db.workflowRuns.filter((w) => w.user === req.session.address) });
});
app.get("/services", usageLimiter, requireAuth, async (req, res) => {
    const db = await loadDb();
    res.json({ serviceRuns: db.serviceRuns.filter((s) => s.user === req.session.address) });
});
app.listen(Number(PORT || 8787), () => {
    console.log(`SPAT Agent backend listening on :${PORT || 8787}`);
});
