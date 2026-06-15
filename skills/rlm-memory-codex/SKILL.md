---
name: rlm-memory-codex
description: Use when working in a codebase and the user needs project memory, semantic file discovery, RLM Memory MCP setup, repo indexing, relevant-file retrieval, prior task history, or durable lessons for future Codex sessions.
---

# RLM Memory Codex Workflow

Use the `rlm-memory` MCP server as a retrieval and memory layer. It is not a source of truth. Always verify important conclusions in source files, tests, configs, docs, and command output.

## Start Of A Non-Trivial Task

1. Determine a stable `project_name`. Prefer an existing project name from `rlm_list_projects`; otherwise use a short repo slug. Use one separate RLM project per repository or workspace.
2. If the project is not registered, call `rlm_init` with the project name and working directory.
3. Check index freshness with `rlm_status` or `rlm_verify_index`.
4. If the index is missing or stale, call `rlm_index_codebase` with bounded patterns and exclusions. Avoid secrets, generated files, dependency folders, build outputs, cache folders, and local state.
5. Call `rlm_query` with the user's request, `include_memories: true`, `include_suggestions: true`, and a focused `max_files`.
6. Build a short context brief from the returned files, memories, confidence, and suggestions.
7. Read the actual files before deciding or editing.

## During The Task

- Treat `relevant_files` as a ranked hypothesis, not proof.
- Keep projects separated by `project_name`; do not reuse one memory project for unrelated repositories.
- If `rlm_query` misses obvious files, use `rg`, project docs, graph tools, tests, and direct source reading.
- Prefer small follow-up queries over broad indexing with `read_content: true`.
- Keep secret values out of prompts and memory writes.

## End Of A Non-Trivial Task

After verification, call `rlm_smart_memory` when there is reusable project knowledge:

- original user prompt or concise task summary
- what changed and why
- files modified with change summaries
- affected areas
- verification commands and results
- caveats, skipped checks, or rollback notes

Do not write memory for guesses, unverified assumptions, secrets, credentials, personal data, or one-off noise.

## If MCP Is Missing

Tell the user the plugin or MCP is not loaded in the current Codex session. For a checkout of this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-codex.ps1
```

```bash
bash scripts/install-codex.sh
```

Then restart Codex or start a new session so MCP tools are reloaded.
