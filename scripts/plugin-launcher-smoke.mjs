import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const dataDir = path.join(root, "smoke-test-data", "plugin-launcher");

const client = new Client({ name: "rlm-memory-plugin-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "scripts", "rlm-memory-mcp-launcher.mjs")],
  cwd: root,
  env: {
    ...process.env,
    RLM_DATA_DIR: dataDir,
    LLM_PROVIDER: "none"
  }
});

await client.connect(transport);
const tools = await client.listTools();
await client.close();

const names = tools.tools.map(tool => tool.name).sort();
for (const required of ["rlm_init", "rlm_index_codebase", "rlm_query", "rlm_smart_memory"]) {
  if (!names.includes(required)) {
    throw new Error(`Missing expected tool: ${required}`);
  }
}

console.log(`PASS plugin launcher exposes ${names.length} tools`);
