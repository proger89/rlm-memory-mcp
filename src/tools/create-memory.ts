/**
 * create_memory tool implementation
 * The "Recursion" step - creates context for future sessions
 */

import { type CreateMemoryInput } from "../schemas/index.js";
import {
  addMemory,
  updateFileMap,
  projectExists,
  updateLastAccessed,
  getFileMap,
  findFileIndex,
  normalizeFilePath
} from "../services/database.js";
import { extractKeywords, generateFileDescription, mapWithConcurrency } from "../services/llm.js";
import type { ToolResult } from "../types.js";

/** Cap concurrent LLM description calls (avoid provider rate limits) */
const DESCRIPTION_CONCURRENCY = 5;

/**
 * Execute the create_memory tool
 */
export async function executeCreateMemory(
  params: CreateMemoryInput
): Promise<ToolResult> {
  const projectName = params.project_name;

  // Check if project exists
  const exists = await projectExists(projectName);
  if (!exists) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `Project '${projectName}' not found. Use rlm_init to create it first.`,
          success: false
        }, null, 2)
      }],
      isError: true
    };
  }

  // Update last accessed
  await updateLastAccessed(projectName);

  // Extract keywords if not provided
  let keywords = params.keywords || [];
  if (keywords.length === 0) {
    const textForKeywords = `${params.user_prompt} ${params.changes_summary}`;
    keywords = await extractKeywords(textForKeywords);
  }

  // Create the memory entry
  const memory = await addMemory(projectName, {
    project_id: projectName,
    user_prompt: params.user_prompt,
    changes_summary: params.changes_summary,
    files_modified: params.files_modified.map(normalizeFilePath),
    keywords
  });

  const editSummary =
    params.changes_summary.length > 200
      ? `${params.changes_summary.slice(0, 200)}...`
      : params.changes_summary;

  // Update file map
  const updatedPaths: string[] = [];
  if (params.file_descriptions && params.file_descriptions.length > 0) {
    const fileEntries = params.file_descriptions.map(fd => ({
      path: fd.path,
      description: fd.description,
      keywords: extractKeywordsSync(fd.description, fd.path),
      edit_summary: editSummary,
      memory_id: memory.id
    }));

    const paths = await updateFileMap(projectName, fileEntries);
    updatedPaths.push(...paths);
  } else if (params.files_modified.length > 0) {
    // Auto-generate descriptions ONLY for files not in the map yet —
    // existing entries keep their (often better) descriptions and just
    // get an edit-history entry. Concurrency is capped so large change
    // sets don't fire dozens of parallel LLM calls.
    const existingMap = await getFileMap(projectName);

    const fileEntries = await mapWithConcurrency(
      params.files_modified,
      DESCRIPTION_CONCURRENCY,
      async (filePath) => {
        const isKnown = findFileIndex(existingMap, filePath) >= 0;
        if (isKnown) {
          // Empty description = preserve the existing one (merge semantics)
          return {
            path: filePath,
            edit_summary: editSummary,
            memory_id: memory.id
          };
        }
        const description = await generateFileDescription(
          filePath,
          params.changes_summary
        );
        return {
          path: filePath,
          description,
          keywords: extractKeywordsSync(description, filePath),
          edit_summary: editSummary,
          memory_id: memory.id
        };
      }
    );

    const paths = await updateFileMap(projectName, fileEntries);
    updatedPaths.push(...paths);
  }

  const textContent = JSON.stringify({
    message: "Memory created successfully",
    id: memory.id,
    timestamp: memory.timestamp,
    project_name: projectName,
    files_updated_in_map: updatedPaths,
    success: true,
    keywords_extracted: keywords
  }, null, 2);

  return {
    content: [{ type: "text", text: textContent }]
  };
}

/**
 * Common words to exclude from keywords (stop words)
 */
const STOP_WORDS = new Set([
  // Articles & pronouns
  "this", "that", "these", "those", "with", "from", "into", "about",
  "which", "there", "their", "them", "then", "than", "what", "when",
  "where", "while", "will", "would", "could", "should", "have", "been",
  "being", "does", "doing", "done", "each", "every", "other", "some",
  "for", "and", "the", "are", "not", "but", "can", "all", "any",
  // Common verbs
  "file", "files", "uses", "used", "using", "provides", "provided",
  "includes", "included", "including", "defines", "defined", "defining",
  "handles", "handled", "handling", "implements", "implemented",
  "creates", "created", "creating", "returns", "returned", "returning",
  "also", "such", "make", "made", "making", "take", "taken", "taking",
  "manages", "managed", "managing", "contains", "contained", "containing",
  "renders", "rendered", "rendering", "allows", "allowed", "allowing",
  "enables", "enabled", "enabling", "perform", "performs", "performing",
  // Generic programming terms (too common to be useful)
  "function", "functions", "method", "methods", "class", "classes",
  "code", "data", "value", "values", "type", "types", "object", "objects",
  "array", "arrays", "string", "strings", "number", "numbers",
  // Filler words
  "based", "related", "various", "different", "specific", "general",
  "main", "core", "base", "basic", "simple", "complex", "custom",
  "ensure", "ensures", "ensuring", "support", "supports", "supporting",
  "through", "within", "across", "between", "along", "during"
]);

/**
 * Technical terms that should be prioritized in keywords
 */
const TECHNICAL_TERMS = new Set([
  // Auth & Security
  "auth", "authentication", "authorization", "jwt", "token", "oauth",
  "session", "login", "logout", "password", "credentials", "security",
  "encrypt", "decrypt", "hash", "cors", "csrf", "permission", "role",
  // API & Web
  "api", "rest", "graphql", "endpoint", "route", "router", "middleware",
  "request", "response", "http", "https", "websocket", "webhook",
  // Database
  "database", "query", "sql", "nosql", "mongo", "postgres", "mysql",
  "redis", "cache", "model", "schema", "migration", "orm",
  // Frontend
  "component", "react", "vue", "angular", "svelte", "hook", "state",
  "props", "render", "template", "style", "css", "html", "dom",
  "form", "input", "button", "modal", "dialog", "menu", "navigation",
  // Backend
  "server", "service", "controller", "handler", "worker", "queue",
  "job", "task", "cron", "scheduler", "logger", "monitor",
  // Testing
  "test", "spec", "mock", "stub", "fixture", "assert", "expect",
  // Config & Utils
  "config", "configuration", "settings", "options", "constants",
  "utils", "utility", "helper", "validator", "validation", "parser",
  // Files & Paths
  "upload", "download", "storage", "file", "image", "media", "asset"
]);

/**
 * Extract meaningful keywords from file path
 */
function extractKeywordsFromPath(filePath: string): string[] {
  // Split path into parts and extract meaningful segments
  const parts = filePath
    .toLowerCase()
    .replace(/\.[a-z]+$/, "") // Remove extension
    .split(/[/\\]/)
    .filter(p => p && p !== "src" && p !== "lib" && p !== "dist");

  const keywords: string[] = [];

  for (const part of parts) {
    // Split camelCase and kebab-case
    const words = part
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .split(/[-_.]/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    keywords.push(...words);
  }

  return [...new Set(keywords)];
}

/**
 * Synchronous keyword extraction with smart filtering
 */
function extractKeywordsSync(text: string, filePath?: string): string[] {
  // Get keywords from file path first (most reliable)
  const pathKeywords = filePath ? extractKeywordsFromPath(filePath) : [];

  // Extract words from text
  const textWords = text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2") // Split camelCase
    .split(/[\W_]+/)
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word));

  // Prioritize technical terms
  const technicalMatches = textWords.filter(w => TECHNICAL_TERMS.has(w));

  // Combine: path keywords first, then technical terms, then other words
  const combined = [
    ...pathKeywords,
    ...technicalMatches,
    ...textWords.filter(w => !technicalMatches.includes(w) && !pathKeywords.includes(w))
  ];

  // Remove duplicates and take top 5-7
  const unique = [...new Set(combined)];
  return unique.slice(0, 7);
}
