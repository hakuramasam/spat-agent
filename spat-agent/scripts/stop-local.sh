#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for svc in backend frontend; do
  PIDFILE="$ROOT/$svc/$svc.pid"
  if [ -f "$PIDFILE" ]; then
    PID="$(cat "$PIDFILE")"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "Stopped $svc (PID $PID)"
    fi
    rm -f "$PIDFILE"
  fi
done

echo "Stopped local services."
