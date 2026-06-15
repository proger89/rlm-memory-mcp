# RLM Memory — AI Agent Integration Guide

This file teaches an AI agent how to use the RLM Memory MCP server.

**How to use this file:** copy the block below into your agent's instruction file:

| Agent | Instruction file |
|-------|------------------|
| Claude Code | `CLAUDE.md` (project or `~/.claude/CLAUDE.md`) |
| OpenAI Codex | `AGENTS.md` |
| Cursor | `.cursorrules` or Project Rules |
| Gemini CLI | `GEMINI.md` |
| Anything else | its system prompt / rules file |

---

## 📋 Copy-paste block (drop into your agent's rules)

```markdown
# RLM Memory Rules

This project uses the rlm-memory MCP server for persistent memory and file discovery.
Project name: <YOUR-PROJECT-NAME>   ← keep this consistent across sessions!

## On every task
1. START: call `rlm_query` with the user's request
   → it returns the relevant files, past related work, and suggestions.
   Read those files first instead of searching the codebase yourself.
2. Do the work.
3. END (mandatory): call `rlm_smart_memory` describing what you changed:
   - changes_context: detailed description of what + why
   - files_modified: every file with change_type and change_summary
   - affected_areas: feature areas touched (e.g. ["auth", "ui"])
   Never skip this — it is how the next session remembers your work.

## First time on this project only
1. `rlm_init` { project_name, working_directory }
2. `rlm_index_codebase` { project_name, directory_path, read_content: true }
3. `rlm_verify_index` — review the gaps it reports; re-index if needed.

## Housekeeping
- Deleted/renamed/moved files? → `rlm_manage_sitemap` to keep the map in sync.
- Prefer `rlm_query` over grep/find/ls for "where is X?" questions.
- `rlm_status` shows project stats; `rlm_list_projects` lists all projects.
```

---

## Why these rules matter

| Rule | What happens if you skip it |
|------|------------------------------|
| `rlm_query` first | Agent greps blindly, wastes tokens, misses context from past sessions |
| `rlm_smart_memory` last | Next session starts from zero — memory never builds up |
| Consistent `project_name` | Memories split across two projects and neither is complete |
| `rlm_manage_sitemap` on renames | The file map points to files that no longer exist |

---

## The full loop, illustrated

**User says: "Fix the login bug"**

```json
// 1️⃣ START — ask the MCP what's relevant
{
  "tool": "rlm_query",
  "project_name": "my-app",
  "user_request": "The user wants to fix the login bug — likely authentication issue"
}
```

The MCP answers with files (`src/auth/login.ts`, …), past memories ("we fixed a
session timeout here last week"), and suggestions. The agent reads those files
and fixes the bug.

```json
// 3️⃣ END — record what was done (MANDATORY)
{
  "tool": "rlm_smart_memory",
  "project_name": "my-app",
  "user_prompt": "Fix the login bug",
  "changes_context": "Fixed null check in auth validation that caused login failures when the session expired. The token refresh path now re-validates before use.",
  "files_modified": [
    {
      "path": "src/auth/login.ts",
      "change_type": "modified",
      "change_summary": "Added null check for session token validation"
    }
  ],
  "affected_areas": ["auth", "validation"]
}
```

**User says: "Set up memory for this project"** (first time)

```json
// 1. Register the project
{ "tool": "rlm_init", "project_name": "my-app", "working_directory": "D:\\projects\\my-app" }

// 2. Build the semantic file map (read_content=true gives much better descriptions)
{ "tool": "rlm_index_codebase", "project_name": "my-app",
  "directory_path": "D:\\projects\\my-app", "max_files": 200, "read_content": true }

// 3. Verify nothing is missing
{ "tool": "rlm_verify_index", "project_name": "my-app",
  "expected_features": ["auth", "api", "components"] }
```

**Files were renamed during a refactor**

```json
{
  "tool": "rlm_manage_sitemap",
  "project_name": "my-app",
  "operations": [
    { "action": "move", "file_path": "src/utils.ts", "new_path": "src/lib/utils.ts" },
    { "action": "delete", "file_path": "src/deprecated/old-helper.ts" },
    { "action": "update", "file_path": "src/api/auth.ts",
      "updates": { "description": "JWT authentication service", "feature_area": "security" } }
  ]
}
```

---

## Tool cheat sheet

| Tool | When | Key inputs |
|------|------|-----------|
| `rlm_query` ⭐ | Start of every task | `project_name`, `user_request` |
| `rlm_smart_memory` ⭐ | End of every task | `project_name`, `user_prompt`, `changes_context`, `files_modified[]` |
| `rlm_init` | Once per project | `project_name`, `working_directory` |
| `rlm_index_codebase` | Once per project (and after big refactors) | `directory_path`, `read_content: true` |
| `rlm_verify_index` | Right after indexing | `expected_features[]` (optional) |
| `rlm_manage_sitemap` | After deletes/renames | `operations[]` (delete/move/update) |
| `rlm_status` | Check project stats | `project_name` |
| `rlm_list_projects` | Find existing project names | — |
| `rlm_recall_memory` | Legacy memory-only search | `keywords[]` |
| `rlm_find_files_by_intent` | Legacy file-only search | `user_prompt` |
| `rlm_create_memory` | Legacy basic memory | `changes_summary`, `files_modified[]` |

---

## Tips for good memories

✅ **Do**
- Write `changes_context` like a commit message a future agent will rely on:
  *"Switched LoginForm submit button from hardcoded #3B82F6 to theme.primary; hover uses theme.primaryDark"*
- List **every** modified file with an accurate `change_type` (`created` / `modified` / `deleted`)
- Use consistent `affected_areas` names across tasks (`auth`, not sometimes `authentication`)

❌ **Don't**
- Don't write vague contexts: *"fixed stuff"*, *"updated files"*
- Don't invent a new `project_name` per session — check `rlm_list_projects` first
- Don't skip `rlm_smart_memory` because the change "was small" — small changes are exactly what gets forgotten

---

## Fallback behavior

If the server has no AI key configured, all tools still work using weighted
keyword matching (path names, descriptions, component types, edit history).
Responses are marked accordingly — the workflow stays the same.
