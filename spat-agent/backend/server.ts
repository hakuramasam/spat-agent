import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import { SiweMessage } from "siwe";
import { ethers } from "ethers";
import Redis from "ioredis";
import { RedisStore } from "connect-redis";

const {
  SESSION_SECRET,
  NODE_ENV,
  CHAIN_ID,
  RPC_URL,
  USAGE_CONTRACT,
  SPAT_TOKEN,
  ALLOWED_ORIGIN,
  REDIS_URL,
  PORT
} = process.env;

if (!SESSION_SECRET) throw new Error("SESSION_SECRET is required");
if (!CHAIN_ID) throw new Error("CHAIN_ID is required");
if (!RPC_URL) throw new Error("RPC_URL is required");
if (!USAGE_CONTRACT) throw new Error("USAGE_CONTRACT is required");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const app = express();

app.set("trust proxy", 1);
app.use(express.json());

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
  redisClient.on("error", (err) => {
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

const actionCosts: Record<string, string> = {
  makeTask: "1000000000000000000",
  runWorkflow: "3000000000000000000",
  useService: "500000000000000000"
};

const actionTypeMap: Record<string, number> = {
  makeTask: 0,
  runWorkflow: 1,
  useService: 2
};

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
    const result = await siwe.verify({
      signature,
      nonce: req.session.nonce
    });

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

app.get("/usage/quote", usageLimiter, (req: any, res) => {
  if (!req.session?.address) return res.status(401).json({ error: "unauthorized" });
  res.json({ actionCosts, token: SPAT_TOKEN || null, usageContract: USAGE_CONTRACT });
});

app.post("/usage/execute", usageLimiter, async (req: any, res) => {
  try {
    if (!req.session?.address) return res.status(401).json({ error: "unauthorized" });

    const { txHash, action, requestId } = req.body;
    if (!txHash || !action || !requestId) return res.status(400).json({ error: "missing_fields" });

    const expectedActionType = actionTypeMap[action];
    const expectedAmount = actionCosts[action];
    if (expectedActionType === undefined || !expectedAmount) return res.status(400).json({ error: "invalid_action" });

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return res.status(400).json({ error: "tx_not_confirmed" });

    const chargedLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== USAGE_CONTRACT.toLowerCase()) return false;
      try {
        const parsed = usageIface.parseLog(log);
        if (!parsed || parsed.name !== "Charged") return false;

        const user = String(parsed.args.user).toLowerCase();
        const actionType = Number(parsed.args.actionType);
        const amount = parsed.args.amount.toString();
        const rid = String(parsed.args.requestId).toLowerCase();

        return (
          user === req.session.address &&
          actionType === expectedActionType &&
          amount === expectedAmount &&
          rid === String(requestId).toLowerCase()
        );
      } catch {
        return false;
      }
    });

    if (!chargedLog) return res.status(400).json({ error: "payment_not_verified" });

    // TODO: enqueue actual agent work queue here.
    return res.json({ ok: true, status: "queued" });
  } catch {
    return res.status(500).json({ error: "internal_error" });
  }
});

app.listen(Number(PORT || 8787), () => {
  console.log(`SPAT Agent backend listening on :${PORT || 8787}`);
});
