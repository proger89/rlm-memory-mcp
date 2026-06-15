/**
 * Smoke test: drives the built MCP server over stdio like a real client.
 * Run: node smoke-test.mjs
 */
import { spawn } from "child_process";

const server = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, RLM_DATA_DIR: "./smoke-test-data" }
});

let buffer = "";
const responses = [];
server.stdout.on("data", chunk => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  }
});
server.stderr.on("data", d => console.error("[server]", d.toString().trim()));

function send(msg) {
  server.stdin.write(JSON.stringify(msg) + "\n");
}

function waitFor(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const found = responses.find(r => r.id === id);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error(`timeout waiting for id ${id}`)); }
    }, 50);
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

try {
  // 1. MCP handshake
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1.0" } } });
  const init = await waitFor(1);
  check("initialize", !!init.result?.serverInfo, init.result?.serverInfo?.name);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = await waitFor(2);
  const toolNames = (tools.result?.tools || []).map(t => t.name);
  check("tools/list has 11 tools", toolNames.length === 11, toolNames.join(","));

  // 3. rlm_init
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rlm_init", arguments: { project_name: "Smoke Test App", working_directory: process.cwd() } } });
  const initTool = await waitFor(3);
  const initText = JSON.parse(initTool.result.content[0].text);
  check("rlm_init sanitizes name", initText.name === "smoke-test-app", initText.name);

  // 4. rlm_create_memory (no LLM key → fallback keywords)
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "rlm_create_memory", arguments: { project_name: "smoke-test-app", user_prompt: "Add JWT authentication", changes_summary: "Implemented JWT token validation middleware for the auth API", files_modified: ["src\\auth\\jwtMiddleware.ts"] } } });
  const mem = await waitFor(4, 20000);
  const memText = JSON.parse(mem.result.content[0].text);
  check("rlm_create_memory works", memText.success === true, `keywords: ${(memText.keywords_extracted || []).join(",")}`);
  check("paths normalized to forward slashes", (memText.files_updated_in_map || [])[0] === "src/auth/jwtMiddleware.ts", (memText.files_updated_in_map || [])[0]);

  // 5. rlm_recall_memory finds it by filename keyword (searchMemories now includes files_modified)
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rlm_recall_memory", arguments: { project_name: "smoke-test-app", keywords: ["jwtmiddleware"] } } });
  const recall = await waitFor(5);
  const recallText = JSON.parse(recall.result.content[0].text);
  check("recall finds memory by filename", recallText.total >= 1, `found ${recallText.total}`);

  // 6. rlm_query (fallback mode) — must return ranked relevant files, not zero
  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "rlm_query", arguments: { project_name: "smoke-test-app", user_request: "Fix the JWT auth middleware" } } });
  const query = await waitFor(6, 20000);
  const queryText = JSON.parse(query.result.content[0].text);
  check("rlm_query returns relevant files", (queryText.relevant_files || []).length >= 1, `files: ${(queryText.relevant_files || []).map(f => f.path).join(",")}`);

  // 7. rlm_manage_sitemap move with backslash path (normalized matching)
  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rlm_manage_sitemap", arguments: { project_name: "smoke-test-app", operations: [{ action: "move", file_path: "src\\auth\\jwtMiddleware.ts", new_path: "src/middleware/jwt.ts" }] } } });
  const sitemap = await waitFor(7);
  const sitemapText = JSON.parse(sitemap.result.content[0].text);
  check("manage_sitemap move (backslash input)", sitemapText.summary?.successful === 1, sitemapText.results?.[0]?.message);

  // 8. unknown project → isError
  send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "rlm_recall_memory", arguments: { project_name: "does-not-exist", keywords: ["x"] } } });
  const notFound = await waitFor(8);
  check("missing project sets isError", notFound.result?.isError === true, JSON.stringify(notFound.result?.isError));

  // 9. rlm_index_codebase on src/ (heuristic mode, no LLM)
  send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "rlm_index_codebase", arguments: { project_name: "smoke-test-app", directory_path: process.cwd() + "\\src", max_files: 50 } } });
  const index = await waitFor(9, 30000);
  const indexText = JSON.parse(index.result.content[0].text);
  check("rlm_index_codebase indexes files", indexText.success === true && indexText.files_indexed > 5, `indexed ${indexText.files_indexed}`);

  // 10. rlm_verify_index — should detect files exist (root_path = cwd, paths relative to src/... missing check skips silently if mismatch)
  send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "rlm_verify_index", arguments: { project_name: "smoke-test-app" } } });
  const verify = await waitFor(10, 20000);
  const verifyText = JSON.parse(verify.result.content[0].text);
  check("rlm_verify_index reports", verifyText.success === true && verifyText.files_indexed > 5, `${verifyText.files_indexed} files`);
} catch (err) {
  check("smoke test crashed", false, String(err));
} finally {
  server.kill();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
