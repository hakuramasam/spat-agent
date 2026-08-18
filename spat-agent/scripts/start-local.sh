#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[1/3] Starting backend (main + MCP)..."
cd "$ROOT/backend"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created backend/.env from .env.example (edit values before use)."
fi
npm install
nohup npm run dev > "$ROOT/backend/backend.log" 2>&1 &
echo $! > "$ROOT/backend/backend.pid"
echo "Backend PID: $(cat "$ROOT/backend/backend.pid")"

echo "[2/3] Preparing frontend config..."
cd "$ROOT/frontend"
if [ ! -f config.js ]; then
  cp config.example.js config.js
  echo "Created frontend/config.js from example."
fi

echo "[3/3] Serving frontend on :3000"
nohup python3 -m http.server 3000 > "$ROOT/frontend/frontend.log" 2>&1 &
echo $! > "$ROOT/frontend/frontend.pid"
echo "Frontend PID: $(cat "$ROOT/frontend/frontend.pid")"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SPAT Agent running                                      ║"
echo "║                                                          ║"
echo "║  Frontend      →  http://localhost:3000                  ║"
echo "║  Backend API   →  http://localhost:8787                  ║"
echo "║  MCP Server    →  http://localhost:8788                  ║"
echo "║  A2A card      →  http://localhost:8787/.well-known/agent.json ║"
echo "║  Health        →  http://localhost:8787/health           ║"
echo "╚══════════════════════════════════════════════════════════╝"
