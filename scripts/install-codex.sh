#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${RLM_DATA_DIR:-$HOME/.codex/rlm-memory-data}"
MODEL="${CODEX_MODEL:-gpt-5.5}"
PROJECT_CWD="${CODEX_CWD:-}"

cd "$ROOT"
npm install
npm run build
mkdir -p "$DATA_DIR"

codex mcp remove rlm-memory >/dev/null 2>&1 || true

args=(
  mcp add rlm-memory
  --env "RLM_DATA_DIR=$DATA_DIR"
  --env "LLM_PROVIDER=codex"
  --env "CODEX_MODEL=$MODEL"
  --env "CODEX_SANDBOX=read-only"
  --env "CODEX_IGNORE_USER_CONFIG=true"
  --env "CODEX_IGNORE_RULES=true"
  --env "LLM_TIMEOUT_MS=120000"
)

if [[ -n "$PROJECT_CWD" ]]; then
  args+=(--env "CODEX_CWD=$PROJECT_CWD")
fi

args+=(-- node "$ROOT/dist/index.js")

codex "${args[@]}"
codex mcp get rlm-memory

echo "Installed rlm-memory for Codex CLI. Restart Codex or start a new session to reload MCP tools."
