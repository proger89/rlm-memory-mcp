/**
 * LLM Service — provider-agnostic AI layer
 *
 * Supports multiple providers so the MCP works with whatever key you have:
 *   - OpenRouter (recommended): any model on https://openrouter.ai, default google/gemini-3.5-flash
 *   - Google Gemini direct:     https://aistudio.google.com, default gemini-3.5-flash
 *
 * Provider selection (env):
 *   LLM_PROVIDER = "auto" (default) | "openrouter" | "gemini"
 *     auto → OPENROUTER_API_KEY ? openrouter : GEMINI_API_KEY ? gemini : none (fallback mode)
 *   LLM_MODEL            — override the model for the active provider
 *   LLM_REASONING_EFFORT — "minimal" | "low" | "medium" | "high" (default "low";
 *                          these are fast utility calls, not deep reasoning)
 *   LLM_MAX_TOKENS       — max output tokens (default 4096)
 *   LLM_TIMEOUT_MS       — per-request timeout (default 60000)
 *
 * Every function degrades gracefully: if no key is configured or the API
 * fails, callers get a keyword-based fallback instead of an exception.
 */

import axios from "axios";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  OPENROUTER_API_URL,
  OPENROUTER_DEFAULT_MODEL,
  GEMINI_API_URL,
  GEMINI_DEFAULT_MODEL
} from "../constants.js";
import type { GeminiGenerateResponse, OpenRouterChatResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type LLMProvider = "openrouter" | "gemini" | "codex" | "none";

export interface LLMStatus {
  provider: LLMProvider;
  model: string | null;
  available: boolean;
}

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string | null;
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  maxTokens: number;
  timeoutMs: number;
  codexCommand: string;
  codexArgsPrefix: string[];
  codexCwd: string | null;
  codexSandbox: string;
  codexIgnoreUserConfig: boolean;
  codexIgnoreRules: boolean;
}

let config: LLMConfig | null = null;

function resolveCodexRuntime(): { command: string; argsPrefix: string[] } {
  const explicitCommand = process.env.CODEX_COMMAND?.trim();
  const explicitEntrypoint = process.env.CODEX_ENTRYPOINT?.trim();
  if (explicitCommand) {
    return {
      command: explicitCommand,
      argsPrefix: explicitEntrypoint ? [explicitEntrypoint] : []
    };
  }
  if (explicitEntrypoint) {
    return { command: process.execPath, argsPrefix: [explicitEntrypoint] };
  }

  if (process.platform === "win32") {
    const pathValue = process.env.Path || process.env.PATH || "";
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(candidate)) {
        return { command: process.execPath, argsPrefix: [candidate] };
      }
    }
  }

  return { command: "codex", argsPrefix: [] };
}

function resolveConfig(): LLMConfig {
  const requested = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const geminiKey = process.env.GEMINI_API_KEY?.trim() || null;

  let provider: LLMProvider;
  let apiKey: string | null;

  if (requested === "openrouter") {
    provider = openrouterKey ? "openrouter" : "none";
    apiKey = openrouterKey;
  } else if (requested === "gemini") {
    provider = geminiKey ? "gemini" : "none";
    apiKey = geminiKey;
  } else if (requested === "codex") {
    provider = "codex";
    apiKey = null;
  } else {
    // auto-detect: prefer OpenRouter, fall back to Gemini direct
    if (openrouterKey) {
      provider = "openrouter";
      apiKey = openrouterKey;
    } else if (geminiKey) {
      provider = "gemini";
      apiKey = geminiKey;
    } else {
      provider = "none";
      apiKey = null;
    }
  }

  const defaultModel =
    provider === "openrouter"
      ? OPENROUTER_DEFAULT_MODEL
      : provider === "gemini"
        ? GEMINI_DEFAULT_MODEL
        : "codex-config-default";

  const effortEnv = (process.env.LLM_REASONING_EFFORT || "low").toLowerCase();
  const reasoningEffort = (["minimal", "low", "medium", "high"] as const).includes(
    effortEnv as "minimal" | "low" | "medium" | "high"
  )
    ? (effortEnv as "minimal" | "low" | "medium" | "high")
    : "low";
  const codexRuntime = resolveCodexRuntime();

  return {
    provider,
    apiKey,
    model: process.env.CODEX_MODEL?.trim() || process.env.LLM_MODEL?.trim() || defaultModel,
    reasoningEffort,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || "4096", 10) || 4096,
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || "60000", 10) || 60000,
    codexCommand: codexRuntime.command,
    codexArgsPrefix: codexRuntime.argsPrefix,
    codexCwd: process.env.CODEX_CWD?.trim() || null,
    codexSandbox: process.env.CODEX_SANDBOX?.trim() || "read-only",
    codexIgnoreUserConfig: process.env.CODEX_IGNORE_USER_CONFIG === "true",
    codexIgnoreRules: process.env.CODEX_IGNORE_RULES !== "false"
  };
}

/**
 * Initialize the LLM service from environment variables.
 * Safe to call multiple times (re-reads env).
 */
export function initLLM(): LLMStatus {
  config = resolveConfig();
  return getLLMStatus();
}

function getConfig(): LLMConfig {
  if (!config) {
    config = resolveConfig();
  }
  return config;
}

/** Whether an AI provider is configured (otherwise keyword fallbacks are used). */
export function isLLMAvailable(): boolean {
  const c = getConfig();
  return c.provider === "codex" || (c.provider !== "none" && !!c.apiKey);
}

/** Current provider/model info for status displays. */
export function getLLMStatus(): LLMStatus {
  const c = getConfig();
  return {
    provider: c.provider,
    model: c.provider === "none" ? null : c.model,
    available: c.provider === "codex" || (c.provider !== "none" && !!c.apiKey)
  };
}

// ---------------------------------------------------------------------------
// Core generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for JSON output (json mode / structured outputs). */
  json?: boolean;
  /** Optional JSON Schema enforced via OpenRouter structured outputs. */
  schema?: Record<string, unknown>;
  schemaName?: string;
}

function isRetryableError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    if (!error.response) return true; // network error / timeout
    const status = error.response.status;
    return status === 429 || status >= 500;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate content using the configured provider.
 * Retries transient failures (429 / 5xx / network) with exponential backoff.
 */
export async function generateContent(
  prompt: string,
  options: GenerateOptions = {}
): Promise<string> {
  const c = getConfig();
  if (c.provider === "none" || (c.provider !== "codex" && !c.apiKey)) {
    throw new Error(
      "No LLM API key configured. Set OPENROUTER_API_KEY (recommended) or GEMINI_API_KEY."
    );
  }

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (c.provider === "openrouter") {
        return await generateViaOpenRouter(c, prompt, options);
      }
      if (c.provider === "codex") {
        return await generateViaCodex(c, prompt, options);
      }
      return await generateViaGemini(c, prompt, options);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryableError(error)) {
        await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s
        continue;
      }
      break;
    }
  }

  throw normalizeError(lastError, c.provider);
}

/**
 * Codex CLI provider — uses the local `codex exec` auth/session instead of
 * a direct API key. This is intended for experiments and low-volume semantic
 * calls; it starts a full Codex CLI process per request.
 */
async function generateViaCodex(
  c: LLMConfig,
  prompt: string,
  options: GenerateOptions
): Promise<string> {
  const args = [
    ...c.codexArgsPrefix,
    "exec",
    "--ephemeral",
    "--sandbox",
    c.codexSandbox,
    "--skip-git-repo-check"
  ];

  if (c.codexIgnoreUserConfig) {
    args.push("--ignore-user-config");
  }
  if (c.codexIgnoreRules) {
    args.push("--ignore-rules");
  }
  if (c.model && c.model !== "codex-config-default") {
    args.push("-m", c.model);
  }
  if (c.codexCwd) {
    args.push("-C", c.codexCwd);
  }

  const boundedPrompt = [
    "You are being called as a JSON-focused helper by RLM Memory MCP.",
    "Return only the requested answer. Do not include logs, markdown fences, or explanations.",
    options.json || options.schema
      ? "The response must be valid JSON and must satisfy the user's requested structure."
      : "The response must be concise plain text.",
    "",
    prompt
  ].join("\n");

  args.push(boundedPrompt);

  const child = spawn(c.codexCommand, args, {
    cwd: c.codexCwd || process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxCaptureBytes = 512 * 1024;

  const collect = (chunks: Buffer[], kind: "stdout" | "stderr") => (chunk: Buffer) => {
    if (kind === "stdout") {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxCaptureBytes) chunks.push(chunk);
    } else {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxCaptureBytes) chunks.push(chunk);
    }
  };

  child.stdout.on("data", collect(stdoutChunks, "stdout"));
  child.stderr.on("data", collect(stderrChunks, "stderr"));

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex CLI timed out after ${c.timeoutMs}ms`));
    }, c.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (exit.code !== 0) {
    throw new Error(`Codex CLI failed (${exit.code ?? exit.signal}): ${stderr || stdout || "no output"}`);
  }

  const json = extractJSON(stdout);
  if (json) {
    return json;
  }

  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line =>
      !line.startsWith("OpenAI Codex ") &&
      !line.startsWith("--------") &&
      !line.startsWith("workdir:") &&
      !line.startsWith("model:") &&
      !line.startsWith("provider:") &&
      !line.startsWith("approval:") &&
      !line.startsWith("sandbox:") &&
      !line.startsWith("reasoning ") &&
      !line.startsWith("session id:") &&
      !line.startsWith("tokens used") &&
      line !== "codex" &&
      line !== "user"
    );

  if (lines.length === 0) {
    throw new Error(`Codex CLI returned no usable content${stderr ? `; stderr: ${stderr.slice(0, 500)}` : ""}`);
  }
  return lines[lines.length - 1];
}

function normalizeError(error: unknown, provider: LLMProvider): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const apiMessage =
      (error.response?.data as { error?: { message?: string } } | undefined)?.error
        ?.message || error.message;
    if (status === 429) {
      return new Error(`${provider} rate limit exceeded. Please wait before retrying.`);
    }
    if (status === 401 || status === 403) {
      return new Error(
        `Invalid ${provider} API key (${status}). Check your ` +
          (provider === "openrouter" ? "OPENROUTER_API_KEY." : "GEMINI_API_KEY.")
      );
    }
    if (status === 402) {
      return new Error("OpenRouter: insufficient credits (402). Top up at openrouter.ai.");
    }
    if (status === 404) {
      return new Error(
        `${provider}: model not found (404). Check LLM_MODEL — current default expects ` +
          (provider === "openrouter" ? `"${OPENROUTER_DEFAULT_MODEL}".` : `"${GEMINI_DEFAULT_MODEL}".`)
      );
    }
    return new Error(`${provider} API error${status ? ` (${status})` : ""}: ${apiMessage}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * OpenRouter — OpenAI-compatible chat completions.
 * https://openrouter.ai/docs
 */
async function generateViaOpenRouter(
  c: LLMConfig,
  prompt: string,
  options: GenerateOptions
): Promise<string> {
  const body: Record<string, unknown> = {
    model: c.model,
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? c.maxTokens,
    // Keep utility calls fast & cheap; OpenRouter maps effort to the nearest
    // level the model supports (e.g. Gemini 3.5 thinking levels).
    reasoning: { effort: c.reasoningEffort }
  };

  if (options.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.schemaName || "response",
        strict: true,
        schema: options.schema
      }
    };
  } else if (options.json) {
    body.response_format = { type: "json_object" };
  }

  const response = await axios.post<OpenRouterChatResponse>(
    `${OPENROUTER_API_URL}/chat/completions`,
    body,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.apiKey}`,
        // Optional attribution headers (shown on openrouter.ai rankings)
        "HTTP-Referer": "https://github.com/jumpino27/RLM-Memory-MCP-Server",
        "X-OpenRouter-Title": "RLM Memory MCP Server",
        "X-Title": "RLM Memory MCP Server"
      },
      timeout: c.timeoutMs
    }
  );

  // OpenRouter can return a 200 with an error payload (e.g. moderation)
  const errMessage = response.data?.error?.message;
  if (errMessage) {
    throw new Error(`OpenRouter error: ${errMessage}`);
  }

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) {
    throw new Error("No content in OpenRouter response");
  }
  return text;
}

/**
 * Google Gemini direct — generativelanguage.googleapis.com REST API.
 * https://ai.google.dev/gemini-api/docs
 */
async function generateViaGemini(
  c: LLMConfig,
  prompt: string,
  options: GenerateOptions,
  omitThinkingConfig = false
): Promise<string> {
  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.3,
    maxOutputTokens: options.maxTokens ?? c.maxTokens
  };

  if (options.json || options.schema) {
    generationConfig.responseMimeType = "application/json";
  }

  // Gemini 3.x supports thinkingLevel; older models would reject it.
  if (!omitThinkingConfig && /^gemini-3/.test(c.model)) {
    generationConfig.thinkingConfig = { thinkingLevel: c.reasoningEffort };
  }

  try {
    const response = await axios.post<GeminiGenerateResponse>(
      `${GEMINI_API_URL}/models/${c.model}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": c.apiKey
        },
        timeout: c.timeoutMs
      }
    );

    // Concatenate ALL text parts — long answers can be split across parts,
    // and thinking models prepend thought parts that must be skipped.
    const parts = response.data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter(p => typeof p.text === "string" && !p.thought)
      .map(p => p.text)
      .join("");
    if (!text.trim()) {
      throw new Error("No content in Gemini response");
    }
    return text;
  } catch (error) {
    // If the model rejects thinkingConfig (400), retry once without it.
    if (
      !omitThinkingConfig &&
      axios.isAxiosError(error) &&
      error.response?.status === 400 &&
      JSON.stringify(error.response.data ?? "").includes("thinking")
    ) {
      return generateViaGemini(c, prompt, options, true);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first balanced JSON object or array from raw model output.
 * Handles markdown fences and leading/trailing prose.
 */
export function extractJSON(raw: string): string | null {
  const text = raw.trim();

  // Fast path: the whole response is JSON
  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue
  }

  // Strip markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      JSON.parse(fenced[1].trim());
      return fenced[1].trim();
    } catch {
      // continue
    }
  }

  // Balanced-bracket scan — try EVERY bracket position, not just the
  // first one (prose like "[ranked best-first]" may precede the JSON).
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const offset = text.slice(searchFrom).search(/[[{]/);
    if (offset === -1) return null;
    const start = searchFrom + offset;

    const candidate = scanBalanced(text, start);
    if (candidate !== null) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Not valid JSON at this bracket — keep scanning
      }
    }
    searchFrom = start + 1;
  }
  return null;
}

/** Extract one balanced {...} or [...] starting at `start`, or null. */
function scanBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Generate and parse a JSON response. Returns null when the model output
 * cannot be parsed (callers should fall back to keyword heuristics).
 */
export async function generateJSON<T>(
  prompt: string,
  options: GenerateOptions = {}
): Promise<T | null> {
  const response = await generateContent(prompt, { ...options, json: true });
  const json = extractJSON(response);
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/**
 * Common words to exclude from keywords (stop words)
 */
const STOP_WORDS = new Set([
  "this", "that", "these", "those", "with", "from", "into", "about",
  "which", "there", "their", "them", "then", "than", "what", "when",
  "where", "while", "will", "would", "could", "should", "have", "been",
  "being", "does", "doing", "done", "each", "every", "other", "some",
  "for", "and", "the", "are", "not", "but", "can", "all", "any",
  "file", "files", "uses", "used", "using", "provides", "provided",
  "includes", "included", "including", "defines", "defined", "defining",
  "handles", "handled", "handling", "implements", "implemented",
  "creates", "created", "creating", "returns", "returned", "returning",
  "also", "such", "make", "made", "making", "take", "taken", "taking",
  "manages", "managed", "managing", "contains", "contained", "containing",
  "renders", "rendered", "rendering", "allows", "allowed", "allowing",
  "enables", "enabled", "enabling", "perform", "performs", "performing",
  "based", "related", "various", "different", "specific", "general",
  "main", "core", "base", "basic", "simple", "complex", "custom",
  "through", "within", "across", "between", "along", "during"
]);

/**
 * Fallback keyword extraction without AI
 */
export function extractKeywordsFallback(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2") // Split camelCase
    .split(/[\W_]+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index)
    .slice(0, 7);
}

/**
 * Extract keywords from text using the LLM (keyword fallback on failure)
 */
export async function extractKeywords(text: string): Promise<string[]> {
  if (!isLLMAvailable()) {
    return extractKeywordsFallback(text);
  }

  const prompt = `Extract 5-7 relevant technical keywords from the following text.
Focus on: specific technologies, features, concepts, and domain terms.
Avoid generic words like: "file", "this", "function", "data", "code", "used", "provides".
Return ONLY a JSON array of lowercase strings, no explanations.
Example output: ["authentication", "jwt", "middleware", "login", "session"]

Text: ${text}`;

  try {
    const keywords = await generateJSON<string[]>(prompt, {
      schema: {
        type: "object",
        properties: {
          keywords: { type: "array", items: { type: "string" } }
        },
        required: ["keywords"],
        additionalProperties: false
      },
      schemaName: "keywords"
    });

    // Structured output wraps in an object; raw JSON mode may return the array
    const list = Array.isArray(keywords)
      ? keywords
      : (keywords as { keywords?: string[] } | null)?.keywords;

    // Filter FIRST, then decide — an all-invalid list (stop words, numbers)
    // must fall back to heuristics, never return an empty keyword set.
    const cleaned = (Array.isArray(list) ? list : [])
      .filter((k): k is string => typeof k === "string")
      .map(k => k.toLowerCase().trim())
      .filter(k => k.length > 0 && !STOP_WORDS.has(k));

    if (cleaned.length > 0) {
      return cleaned.slice(0, 10);
    }
    return extractKeywordsFallback(text);
  } catch {
    return extractKeywordsFallback(text);
  }
}

// ---------------------------------------------------------------------------
// File ↔ intent matching
// ---------------------------------------------------------------------------

/**
 * Enhanced file data for semantic matching
 */
export interface EnhancedFileData {
  path: string;
  description: string;
  keywords: string[];
  component_type?: string;
  feature_area?: string;
  edit_history?: Array<{ date: string; summary: string }>;
}

/**
 * Match user intent to files using the LLM with enhanced semantic search.
 * Considers component type, feature area, and edit history.
 */
export async function matchFilesToIntent(
  intent: string,
  files: Array<EnhancedFileData>
): Promise<{ files: string[]; reasoning: string }> {
  if (files.length === 0) {
    return { files: [], reasoning: "No files in the project map yet." };
  }

  if (!isLLMAvailable()) {
    return smartKeywordMatch(intent, files);
  }

  // For very large maps, pre-filter with keyword scoring so the prompt
  // stays well under context/cost limits.
  const candidates =
    files.length > 150 ? preFilterFiles(intent, files, 150) : files;

  // Build rich file context including edit history
  const filesText = candidates
    .map(f => {
      const keywords = f.keywords || [];
      const history = f.edit_history?.slice(-2).map(e => `    • ${e.summary || "unknown"}`).join("\n") || "";
      return `- ${f.path}
    Description: ${f.description || "No description"}
    Type: ${f.component_type || "unknown"} | Area: ${f.feature_area || "general"}
    Keywords: [${keywords.join(", ") || "none"}]
    ${history ? `Recent edits:\n${history}` : ""}`;
    })
    .join("\n\n");

  const prompt = `You are an AI assistant helping to find relevant files in a codebase.
Given the user's intent and a list of files with descriptions, return the most relevant file paths.

User Intent: "${intent}"

Available Files:
${filesText}

IMPORTANT RULES FOR SELECTION:
1. Be SPECIFIC - if the user mentions "the submit button", find THAT specific button, not all buttons
2. Use component_type and feature_area to narrow down - don't return all UI components
3. Consider edit history - files recently edited for similar tasks are more relevant
4. Prioritize exact matches over partial matches
5. Return files in order of relevance (most relevant first)
6. Maximum 5-7 files unless the task clearly requires more
7. Only return paths that appear in the list above - never invent paths

Return ONLY a JSON object with this structure:
{
  "files": ["path1", "path2"],
  "reasoning": "Brief explanation of why these specific files were selected"
}`;

  try {
    const result = await generateJSON<{ files: string[]; reasoning: string }>(prompt, {
      schema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          reasoning: { type: "string" }
        },
        required: ["files", "reasoning"],
        additionalProperties: false
      },
      schemaName: "file_match"
    });

    if (result && Array.isArray(result.files)) {
      // Guard against hallucinated paths — compare normalized (separator/case
      // drift in model output must not drop valid results) and return the
      // canonical stored path.
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      const known = new Map(files.map(f => [normalize(f.path), f.path]));
      const valid = result.files
        .filter((p): p is string => typeof p === "string")
        .map(p => known.get(normalize(p)))
        .filter((p): p is string => p !== undefined);
      if (valid.length > 0) {
        return { files: valid, reasoning: result.reasoning || "" };
      }
    }
    return smartKeywordMatch(intent, files);
  } catch {
    // Fallback: smart keyword matching with type/area consideration
    return smartKeywordMatch(intent, files);
  }
}

/**
 * Keyword pre-filter used to cap prompt size on large file maps
 */
function preFilterFiles(
  intent: string,
  files: Array<EnhancedFileData>,
  limit: number
): Array<EnhancedFileData> {
  const ranked = scoreFiles(intent, files);
  const top = ranked.filter(s => s.score > 0).slice(0, limit).map(s => s.file);
  // If keyword scoring finds too little, keep the most recently edited files
  if (top.length < limit) {
    const seen = new Set(top.map(f => f.path));
    for (const f of files) {
      if (top.length >= limit) break;
      if (!seen.has(f.path)) top.push(f);
    }
  }
  return top;
}

export function scoreFiles(
  intent: string,
  files: Array<EnhancedFileData>
): Array<{ file: EnhancedFileData; score: number }> {
  const intentWords = intent.toLowerCase().split(/\W+/).filter(w => w.length > 2);

  const scored = files.map(file => {
    let score = 0;
    const keywords = file.keywords || [];
    const fileText = `${file.path} ${file.description || ""} ${keywords.join(" ")}`.toLowerCase();

    // Base score from keyword matches
    for (const word of intentWords) {
      if (fileText.includes(word)) score += 1;
      // Boost if word appears in path (more specific)
      if (file.path.toLowerCase().includes(word)) score += 2;
    }

    // Boost for component type match
    if (file.component_type) {
      const typeWords = file.component_type.toLowerCase().split("-");
      for (const word of intentWords) {
        if (typeWords.some(tw => tw.includes(word) || word.includes(tw))) {
          score += 3;
        }
      }
    }

    // Boost for feature area match
    if (file.feature_area) {
      const areaWords = file.feature_area.toLowerCase().split("-");
      for (const word of intentWords) {
        if (areaWords.some(aw => aw.includes(word) || word.includes(aw))) {
          score += 3;
        }
      }
    }

    // Boost for recent edits (more active files)
    if (file.edit_history && file.edit_history.length > 0) {
      score += 1;
      // Check if recent edits are related
      const recentEdits = file.edit_history.slice(-3).map(e => (e.summary || "").toLowerCase()).join(" ");
      for (const word of intentWords) {
        if (recentEdits.includes(word)) score += 2;
      }
    }

    return { file, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Smart keyword matching fallback with component type and feature area consideration
 */
function smartKeywordMatch(
  intent: string,
  files: Array<EnhancedFileData>
): { files: string[]; reasoning: string } {
  const topMatches = scoreFiles(intent, files)
    .filter(s => s.score > 0)
    .slice(0, 7);

  return {
    files: topMatches.map(m => m.file.path),
    reasoning: `Matched using keyword analysis with component type and feature area weighting (AI unavailable). Top matches scored by: keyword presence, path specificity, type/area relevance, and recent edit history.`
  };
}

// ---------------------------------------------------------------------------
// File descriptions
// ---------------------------------------------------------------------------

/**
 * Generate a file description from its path and context
 */
export async function generateFileDescription(
  filePath: string,
  context: string
): Promise<string> {
  if (!isLLMAvailable()) {
    return fallbackDescription(filePath);
  }

  const prompt = `Based on the file path and context, generate a brief (1-2 sentence) description of what this file likely does.

File Path: ${filePath}
Context: ${context}

Return ONLY the description, no explanations or formatting.`;

  try {
    const response = await generateContent(prompt);
    return response.trim();
  } catch {
    return fallbackDescription(filePath);
  }
}

function fallbackDescription(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  const fileName = parts[parts.length - 1];
  return `File: ${fileName} in ${parts.slice(0, -1).join("/")}`;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with at most `concurrency` tasks in flight.
 * Used to keep bulk LLM calls (e.g. indexing) from hammering the provider.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------

/**
 * @deprecated Use initLLM() — kept so older imports keep working.
 */
export function initGemini(_key: string): void {
  initLLM();
}
