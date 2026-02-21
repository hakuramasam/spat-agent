/**
 * Minimal backend sketch:
 * - SIWE auth endpoints
 * - usage quote endpoint
 * - execute endpoint (after wallet approval)
 */
import express from "express";
import session from "express-session";
import { randomBytes } from "crypto";

const app = express();
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || "dev", resave: false, saveUninitialized: false }));

app.get("/auth/nonce", (_req, res) => {
  const nonce = randomBytes(16).toString("hex");
  res.json({ nonce });
});

app.post("/auth/verify", async (req: any, res) => {
  // Verify SIWE message + signature here with your preferred library.
  // On success:
  req.session.address = (req.body.address || "").toLowerCase();
  res.json({ ok: true, address: req.session.address });
});

app.get("/usage/quote", (req: any, res) => {
  if (!req.session?.address) return res.status(401).json({ error: "unauthorized" });
  res.json({
    actionCosts: {
      makeTask: "1000000000000000000",
      runWorkflow: "3000000000000000000",
      useService: "500000000000000000"
    }
  });
});

app.post("/usage/execute", async (req: any, res) => {
  if (!req.session?.address) return res.status(401).json({ error: "unauthorized" });
  // Expected flow:
  // 1) Frontend asks wallet to approve SPATAgentUsage contract for amount.
  // 2) Frontend submits tx hash + request metadata.
  // 3) Backend validates and starts agent task/workflow/service.
  // 4) On success, user has paid in SPAT via on-chain charge() call.
  res.json({ ok: true, status: "queued" });
});

app.listen(8787, () => {
  console.log("SPAT Agent backend listening on :8787");
});
