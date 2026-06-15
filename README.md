# RLM Memory MCP Server

**Persistent memory + semantic file discovery for ANY AI coding agent.**

Works with Claude Code, OpenAI Codex, Gemini CLI, Cursor, Windsurf — anything that speaks [MCP](https://modelcontextprotocol.io).

> Codex-native fork: this version adds `LLM_PROVIDER=codex`, so semantic file discovery can use the already authenticated local Codex CLI (`codex exec`) instead of an external OpenRouter/Gemini API key.

## What is this?

AI agents forget everything between sessions. This MCP server fixes that:

- 🧠 **Memory** — after every task, the agent records *what* it changed and *why*. Next session, it remembers.
- 🗺️ **File map** — a semantic index of your codebase ("this file is the login form", "this is the checkout API"), so the agent finds the right files **without grepping the whole repo**.
- 🔄 **Bi-directional** — the agent *asks* the MCP ("user wants to fix the submit button — which files?") and the MCP answers with files, history, and suggestions.

The core idea (Recursive Large Model): the agent stays intentionally "blind" to the filesystem and uses the MCP as its eyes and memory — making it faster, cheaper, and more focused.

```
┌────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code, Codex, Gemini CLI, Cursor...)  │
│                                                        │
│  "User wants to fix login" ──► rlm_query               │
│                            ◄── relevant files+history  │
│  [does the work]                                       │
│  "Here's what I changed"   ──► rlm_smart_memory        │
└────────────────────────────────────────────────────────┘
                          │ stdio (MCP)
┌────────────────────────────────────────────────────────┐
│  RLM Memory MCP Server                                 │
│  • JSON storage per project (projects/<name>/.rlm/)    │
│  • AI-powered matching via OpenRouter or Gemini        │
│  • Web UI for you at http://localhost:3848             │
└────────────────────────────────────────────────────────┘
```

---

## Install As A Codex Plugin

Give Codex this repository URL and ask it to install the plugin:

```text
https://github.com/proger89/rlm-memory-mcp
```

The repository is self-describing for Codex plugin installs:

- `.codex-plugin/plugin.json` — plugin metadata, display name, icon, default prompts
- `.mcp.json` — bundled `rlm-memory` MCP server
- `skills/rlm-memory-codex/SKILL.md` — Codex workflow for indexing, querying, verifying, and storing lessons
- `assets/icon.svg` and `assets/logo.svg` — plugin artwork
- `scripts/rlm-memory-mcp-launcher.mjs` — auto-build launcher for plugin MCP startup

Manual plugin flow, if your Codex build supports slash commands:

```text
/plugin marketplace add proger89/rlm-memory-mcp
/plugin install rlm-memory-mcp@rlm-memory-mcp
/reload-plugins
```

After installation, start a new Codex session so the bundled MCP tools and skill metadata are loaded.

## Quick Setup: OpenAI Codex CLI

Prerequisites:

- Node.js 18+
- OpenAI Codex CLI installed and authenticated (`codex auth login` / web auth)
- Git

Windows PowerShell:

```powershell
git clone https://github.com/proger89/rlm-memory-mcp.git "$env:USERPROFILE\.codex\mcp\rlm-memory-mcp-server"
Set-Location "$env:USERPROFILE\.codex\mcp\rlm-memory-mcp-server"
npm install
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-codex.ps1
```

macOS/Linux:

```bash
git clone https://github.com/proger89/rlm-memory-mcp.git "$HOME/.codex/mcp/rlm-memory-mcp-server"
cd "$HOME/.codex/mcp/rlm-memory-mcp-server"
npm install
npm run build
bash scripts/install-codex.sh
```

The installer registers this MCP globally with Codex:

```text
name: rlm-memory
provider: codex
model: gpt-5.5
data dir: ~/.codex/rlm-memory-data
```

Use one RLM project per repository. The MCP process can be global, while memory stays separated by the `project_name` and `working_directory` passed to `rlm_init`; each repo should have its own stable slug.

After adding a new MCP server, restart Codex or start a new Codex CLI/session so the tool list is reloaded.

For project-specific best results, set `CODEX_CWD` to the project root when adding the MCP server, or use a project `.codex/config.toml`. The helper Codex process runs with `--sandbox read-only` by default.

## Setup in 3 Steps

### 1. Install & build

```bash
git clone https://github.com/proger89/rlm-memory-mcp.git
cd rlm-memory-mcp
npm install
npm run build
```

### 2. Choose an LLM provider

For Codex CLI auth, no external API key is required:

```env
LLM_PROVIDER=codex
CODEX_MODEL=gpt-5.5
CODEX_SANDBOX=read-only
LLM_TIMEOUT_MS=120000
```

Or copy `.env.example` to `.env` and set one external provider key:


```env
# Option A (recommended): OpenRouter — one key, any model
# https://openrouter.ai/keys
OPENROUTER_API_KEY="sk-or-..."

# Option B: Google Gemini direct — https://aistudio.google.com/
# GEMINI_API_KEY="..."
```

- With **OpenRouter** the server uses **`google/gemini-3.5-flash`** by default — fast, cheap, near-Pro quality.
- With **Gemini direct** it uses **`gemini-3.5-flash`**.
- **Codex provider?** Uses your local `codex exec` auth/session.
- **No provider/key at all?** Everything still works using keyword matching (just less smart).

Want a different model? Set `LLM_MODEL` (e.g. `anthropic/claude-haiku-4.5` or `openai/gpt-4o-mini` on OpenRouter). See `.env.example` for all options.

### 3. Connect your AI agent

Replace `C:\\path\\to` with where you cloned the repo.

**Claude Code** (one command):

```bash
claude mcp add rlm-memory -- node C:\\path\\to\\RLM-Memory-MCP-Server\\dist\\index.js
```

**OpenAI Codex CLI** — recommended command:

```bash
codex mcp add rlm-memory \
  --env LLM_PROVIDER=codex \
  --env CODEX_MODEL=gpt-5.5 \
  --env CODEX_SANDBOX=read-only \
  --env CODEX_IGNORE_USER_CONFIG=true \
  --env CODEX_IGNORE_RULES=true \
  --env LLM_TIMEOUT_MS=120000 \
  --env RLM_DATA_DIR="$HOME/.codex/rlm-memory-data" \
  -- node "$HOME/.codex/mcp/rlm-memory-mcp-server/dist/index.js"
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.rlm-memory]
command = "node"
args = ["C:\\path\\to\\rlm-memory-mcp\\dist\\index.js"]

[mcp_servers.rlm-memory.env]
LLM_PROVIDER = "codex"
CODEX_MODEL = "gpt-5.5"
CODEX_SANDBOX = "read-only"
CODEX_IGNORE_USER_CONFIG = "true"
CODEX_IGNORE_RULES = "true"
LLM_TIMEOUT_MS = "120000"
RLM_DATA_DIR = "C:\\Users\\you\\.codex\\rlm-memory-data"
```

**Gemini CLI** — add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "rlm-memory": {
      "command": "node",
      "args": ["C:\\path\\to\\RLM-Memory-MCP-Server\\dist\\index.js"]
    }
  }
}
```

**Any other MCP client**: launch `node dist/index.js` over stdio.

> 💡 **Tell your agent how to use it:** copy the rules from [example_agents.md](./example_agents.md) into your agent's instructions file (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …).

---

## The Workflow

**First time on a project** — index it once:

```
rlm_init → rlm_index_codebase → rlm_verify_index
```

**Every task after that** — three steps:

```
1. rlm_query          "User wants X — which files?"   → files + history + tips
2. (agent does the actual work)
3. rlm_smart_memory   "Here's what I changed"         → remembered forever
```

That's it. The more the agent works, the smarter the memory gets.

---

## The Tools

### Daily drivers

| Tool | What it does |
|------|--------------|
| `rlm_query` | ⭐ **Start every task here.** Ask about the user's request → get relevant files, past memories, and suggestions |
| `rlm_smart_memory` | ⭐ **End every task here.** Record changes with rich metadata (component types, feature areas, edit history) |

### Project setup

| Tool | What it does |
|------|--------------|
| `rlm_init` | Register a project for memory tracking |
| `rlm_index_codebase` | Scan a codebase and build the semantic file map |
| `rlm_verify_index` | Post-index check: "Is this everything?" — shows breakdown + gaps |

### Maintenance & extras

| Tool | What it does |
|------|--------------|
| `rlm_manage_sitemap` | Keep the file map in sync when files are deleted/moved/renamed |
| `rlm_status` | Project statistics |
| `rlm_list_projects` | All tracked projects |
| `rlm_recall_memory` | Simple keyword memory search (legacy — prefer `rlm_query`) |
| `rlm_find_files_by_intent` | Semantic file search (legacy — prefer `rlm_query`) |
| `rlm_create_memory` | Basic memory creation (legacy — prefer `rlm_smart_memory`) |

### Example: `rlm_query`

```json
{
  "project_name": "my-app",
  "user_request": "The user wants to fix the submit button color on the login form"
}
```

Returns:

```json
{
  "relevant_files": [
    { "path": "src/components/LoginForm.tsx", "description": "Login form with submit button",
      "component_type": "form", "feature_area": "auth",
      "recent_changes": ["Added hover state to submit button"] }
  ],
  "relevant_memories": [
    { "summary": "Changed submit button to theme primary color", "date": "..." }
  ],
  "ai_analysis": "The submit button lives in LoginForm.tsx and uses theme.ts colors...",
  "suggestions": ["Check theme.ts for the color tokens"]
}
```

### Example: `rlm_smart_memory`

```json
{
  "project_name": "my-app",
  "user_prompt": "Fix the submit button color",
  "changes_context": "Changed the submit button in LoginForm to use the primary theme color instead of hardcoded blue. Added hover state.",
  "files_modified": [
    { "path": "src/components/LoginForm.tsx", "change_type": "modified",
      "change_summary": "Button color now uses theme.primary, added hover state" }
  ],
  "affected_areas": ["auth", "ui"]
}
```

---

## The Web UI (for you, the human)

```bash
npm start   # → http://localhost:3848
```

- Browse all projects, memories, and the semantic file map
- Test every MCP tool from the browser
- Delete stale memories / file entries
- See live AI provider status (e.g. `openrouter · google/gemini-3.5-flash`)

---

## Configuration Reference

All settings live in `.env` (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | OpenRouter key (recommended) — [get one](https://openrouter.ai/keys) |
| `GEMINI_API_KEY` | — | Google Gemini key — [get one](https://aistudio.google.com/) |
| `LLM_PROVIDER` | `auto` | `auto` / `codex` / `openrouter` / `gemini`. Auto prefers OpenRouter, then Gemini |
| `LLM_MODEL` | `google/gemini-3.5-flash` (OpenRouter) / `gemini-3.5-flash` (direct) | Any model your provider offers |
| `CODEX_MODEL` | Codex config default | Model for `LLM_PROVIDER=codex`, for example `gpt-5.5` |
| `CODEX_COMMAND` | `codex` or detected Node runtime | Optional command used to launch Codex CLI |
| `CODEX_ENTRYPOINT` | auto-detected on Windows when possible | Optional path to `@openai/codex/bin/codex.js`; useful on Windows to avoid `.cmd` wrapper issues |
| `CODEX_CWD` | MCP server cwd | Optional project root passed to `codex exec -C` |
| `CODEX_SANDBOX` | `read-only` | Sandbox passed to `codex exec --sandbox` |
| `CODEX_IGNORE_USER_CONFIG` | `false` | Pass `--ignore-user-config` to helper Codex calls |
| `CODEX_IGNORE_RULES` | `true` | Pass `--ignore-rules` to helper Codex calls unless set to `false` |
| `LLM_REASONING_EFFORT` | `low` | `minimal` / `low` / `medium` / `high` — thinking depth for helper calls |
| `LLM_MAX_TOKENS` | `4096` | Max output tokens per call |
| `LLM_TIMEOUT_MS` | `60000` | Per-request timeout |
| `UI_PORT` | `3848` | Web UI port |
| `RLM_DATA_DIR` | `<install dir>/projects` | Where project memories are stored (set it to keep data outside the install tree) |

**Scripts:** `npm start` (web UI) · `npm run mcp` (MCP server directly) · `npm run build` · `npm test` (end-to-end smoke test) · `npm run dev` (UI with auto-reload) · `npm run typecheck`

---

## How data is stored

Everything is plain JSON — no database needed:

```
RLM-Memory-MCP-Server/
└── projects/
    └── my-app/.rlm/
        ├── config.json       # project info
        ├── memory_log.json   # every recorded task
        └── file_map.json     # the semantic file index
```

**Back up** by copying `projects/`. **Inspect** with any text editor or the web UI.

---

## FAQ

**Does this work without an API key?**
Yes. With `LLM_PROVIDER=codex`, it uses your local Codex CLI auth/session. With no Codex/OpenRouter/Gemini provider configured, all tools fall back to weighted keyword matching.

**Why store data centrally instead of in each repo?**
One place to back up, browsable across projects in the UI, no `.rlm` clutter in your repos, survives repo deletion.

**Which agent works best?**
Any MCP-capable agent. The tool descriptions teach the agent how to use them, and [example_agents.md](./example_agents.md) has drop-in instructions.

**`rlm_query` vs `rlm_recall_memory`?**
`rlm_query` searches files + memories + edit history and adds AI analysis. `rlm_recall_memory` only searches memories by keyword. Use `rlm_query`.

**How much does the AI cost?**
Helper calls are small and run at low reasoning effort. With `google/gemini-3.5-flash` ($1.50/M input, $9/M output) typical queries cost fractions of a cent.

---

## Project structure (for contributors)

```
src/
├── index.ts            # MCP server entry (stdio) — registers all tools
├── ui/server.ts        # Web UI (Express) at localhost:3848
├── services/
│   ├── llm.ts          # Multi-provider AI layer (OpenRouter / Gemini + fallbacks)
│   └── database.ts     # JSON file storage
├── tools/              # MCP tool implementations
├── schemas/index.ts    # Zod input validation
├── types.ts            # Shared types
└── constants.ts        # Paths, models, limits
```

## License

MIT
