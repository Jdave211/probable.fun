#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_LOG="${BACKEND_LOG:-/tmp/probable-backend.log}"

if [[ ! -d "${PROJECT_ROOT}/.venv" ]]; then
  echo "Missing .venv. Create it with: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

if [[ -f "${PROJECT_ROOT}/.env.local" ]]; then
  set -a
  source "${PROJECT_ROOT}/.env.local"
  set +a
elif [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  source "${PROJECT_ROOT}/.env"
  set +a
else
  echo "No .env.local or .env found. Copy .env.example and fill values first." >&2
  exit 1
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "Starting FastAPI backend on http://${BACKEND_HOST}:${BACKEND_PORT} ..."
"${PROJECT_ROOT}/.venv/bin/python" \
  -m uvicorn backend.main:app \
  --reload \
  --host "${BACKEND_HOST}" \
  --port "${BACKEND_PORT}" \
  >"${BACKEND_LOG}" 2>&1 &
BACKEND_PID=$!

echo "Backend logs: ${BACKEND_LOG}"
echo "Starting Vite frontend on http://${FRONTEND_HOST}:${FRONTEND_PORT} ..."
cd "${PROJECT_ROOT}"
npm run dev -- --host "${FRONTEND_HOST}" --port "${FRONTEND_PORT}"
