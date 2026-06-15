import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const distIndex = path.join(root, "dist", "index.js");

function log(message) {
  process.stderr.write(`[rlm-memory-mcp] ${message}\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true
  });

  if (result.stdout?.trim()) log(result.stdout.trim());
  if (result.stderr?.trim()) log(result.stderr.trim());
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

if (!existsSync(distIndex)) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  log("dist/index.js not found; installing dependencies and building once.");
  run(npmCommand, ["install"]);
  run(npmCommand, ["run", "build"]);
}

process.env.RLM_DATA_DIR ||= path.join(os.homedir(), ".codex", "rlm-memory-data");
process.env.LLM_PROVIDER ||= "codex";
process.env.CODEX_MODEL ||= "gpt-5.5";
process.env.CODEX_SANDBOX ||= "read-only";
process.env.CODEX_IGNORE_USER_CONFIG ||= "true";
process.env.CODEX_IGNORE_RULES ||= "true";
process.env.LLM_TIMEOUT_MS ||= "120000";

mkdirSync(process.env.RLM_DATA_DIR, { recursive: true });

if (process.platform === "win32" && !process.env.CODEX_COMMAND) {
  const candidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : null,
    "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js"
  ].filter(Boolean);

  const entrypoint = candidates.find(candidate => existsSync(candidate));
  if (entrypoint) {
    process.env.CODEX_COMMAND = process.execPath;
    process.env.CODEX_ENTRYPOINT ||= entrypoint;
  }
}

await import(pathToFileURL(distIndex).href);
