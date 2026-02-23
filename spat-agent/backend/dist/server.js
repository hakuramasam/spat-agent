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
const { SESSION_SECRET, NODE_ENV, CHAIN_ID, RPC_URL, USAGE_CONTRACT, SPAT_TOKEN, ALLOWED_ORIGIN, REDIS_URL, PORT } = process.env;
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
app.use(express.json());
const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "runtime-db.json");
const defaultDb = {
    tasks: [],
    workflowRuns: [],
    serviceRuns: [],
    jobs: []
};
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
        setTimeout(async () => {
            const nextDb = await loadDb();
            const target = nextDb.workflowRuns.find((r) => r.id === run.id);
            if (!target)
                return;
            target.status = "done";
            target.updatedAt = new Date().toISOString();
            target.result = {
                summary: `Workflow ${target.name} completed`,
                stepsExecuted: 3
            };
            await saveDb(nextDb);
        }, 1200);
        return { type: "workflowRun", id: run.id, data: run };
    }
    const service = {
        id: newId("svc"),
        user,
        service: payload?.service || "default-service",
        params: payload?.params,
        status: "running",
        createdAt: now,
        updatedAt: now
    };
    db.serviceRuns.push(service);
    await saveDb(db);
    setTimeout(async () => {
        const nextDb = await loadDb();
        const target = nextDb.serviceRuns.find((r) => r.id === service.id);
        if (!target)
            return;
        target.status = "done";
        target.updatedAt = new Date().toISOString();
        target.output = {
            message: `Service ${target.service} executed successfully`
        };
        await saveDb(nextDb);
    }, 900);
    return { type: "serviceRun", id: service.id, data: service };
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
