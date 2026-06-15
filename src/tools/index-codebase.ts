/**
 * rlm_index_codebase tool implementation
 * Scans and indexes an existing codebase to build the file map
 *
 * Performance notes:
 *  - read_content=false (default): pure path heuristics, ZERO LLM calls — fast
 *  - read_content=true: one LLM call per file, capped at 5 concurrent
 */

import * as fs from "fs/promises";
import * as path from "path";
import picomatch from "picomatch";
import { type RLMIndexCodebaseInput } from "../schemas/index.js";
import {
  projectExists,
  updateLastAccessed,
  updateFileMap,
  addMemory,
  initializeProject
} from "../services/database.js";
import { generateJSON, mapWithConcurrency, isLLMAvailable } from "../services/llm.js";
import type { ToolResult } from "../types.js";

/** Cap concurrent LLM calls during indexing */
const INDEX_CONCURRENCY = 5;

/** Skip reading files larger than this (content mode) */
const MAX_READ_BYTES = 512 * 1024;

/**
 * Common words to exclude from keywords
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
  "through", "within", "across", "between", "along", "during",
  "import", "export", "require", "module", "default", "const", "let", "var",
  // Additional common words
  "likely", "typically", "usually", "often", "serves", "serving",
  "central", "primary", "entry", "point",
  "stores", "storing", "stored", "globally", "accessible", "immutable"
]);

/**
 * Directories that are always skipped during the scan, regardless of
 * user-supplied exclude patterns.
 */
const ALWAYS_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "coverage", "__pycache__", "vendor", "target", ".venv", "venv", "env",
  ".idea", ".vscode", ".cache", ".turbo", ".svelte-kit", ".angular",
  "bower_components", ".gradle", ".mvn", "bin", "obj", ".tox", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "eggs", ".eggs", "htmlcov"
]);

/**
 * File type descriptions for common patterns
 */
const FILE_TYPE_HINTS: Record<string, string> = {
  // Components
  "component": "UI component",
  "components": "UI components directory",
  "button": "Button component",
  "form": "Form component",
  "modal": "Modal/dialog component",
  "header": "Header component",
  "footer": "Footer component",
  "sidebar": "Sidebar component",
  "nav": "Navigation component",
  "layout": "Layout component",
  "page": "Page component",
  "view": "View component",

  // Hooks & State
  "hook": "React hook",
  "hooks": "React hooks directory",
  "use": "React hook",
  "context": "React context provider",
  "store": "State store",
  "reducer": "State reducer",
  "action": "State actions",
  "slice": "Redux slice",

  // API & Routes
  "api": "API endpoint/client",
  "route": "Route handler",
  "routes": "Routes directory",
  "router": "Router configuration",
  "controller": "Controller",
  "handler": "Request handler",
  "endpoint": "API endpoint",
  "middleware": "Middleware",

  // Services & Utils
  "service": "Service layer",
  "services": "Services directory",
  "util": "Utility functions",
  "utils": "Utilities directory",
  "helper": "Helper functions",
  "helpers": "Helpers directory",
  "lib": "Library code",

  // Auth & Security
  "auth": "Authentication",
  "login": "Login functionality",
  "logout": "Logout functionality",
  "register": "Registration",
  "session": "Session management",
  "jwt": "JWT token handling",
  "oauth": "OAuth integration",
  "permission": "Permission handling",

  // Database & Models
  "model": "Data model",
  "models": "Models directory",
  "schema": "Database schema",
  "migration": "Database migration",
  "seed": "Database seeder",
  "repository": "Data repository",
  "entity": "Database entity",

  // Config
  "config": "Configuration",
  "env": "Environment configuration",
  "settings": "Settings",
  "constant": "Constants",
  "constants": "Constants directory",

  // Testing
  "test": "Test file",
  "spec": "Test specification",
  "mock": "Mock data/functions",
  "fixture": "Test fixtures",

  // Types
  "type": "Type definitions",
  "types": "Types directory",
  "interface": "Interface definitions",
  "dto": "Data transfer object"
};

/**
 * Extract keywords from file path
 */
function extractKeywordsFromPath(filePath: string): string[] {
  const parts = filePath
    .toLowerCase()
    .replace(/\.[a-z]+$/, "")
    .split(/[/\\]/)
    .filter(p => p && !["src", "lib", "dist", "app", "index"].includes(p));

  const keywords: string[] = [];

  for (const part of parts) {
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
 * Generate description from file path using heuristics
 */
function generateDescriptionFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  const fileName = parts[parts.length - 1].replace(/\.[a-z]+$/, "");
  const dirName = parts.length > 1 ? parts[parts.length - 2] : "";

  // Split camelCase/PascalCase
  const fileWords = fileName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[-_\s]+/);

  // Find hints from file/dir name
  const hints: string[] = [];
  for (const word of [...fileWords, dirName.toLowerCase()]) {
    if (FILE_TYPE_HINTS[word]) {
      hints.push(FILE_TYPE_HINTS[word]);
    }
  }

  // Build description
  const readableName = fileWords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  if (hints.length > 0) {
    return `${readableName} - ${hints.join(", ")}`;
  }

  // Extension-based hints
  const ext = path.extname(filePath).toLowerCase();
  const extHints: Record<string, string> = {
    ".tsx": "React component",
    ".jsx": "React component",
    ".vue": "Vue component",
    ".svelte": "Svelte component",
    ".d.ts": "Type definitions",
    ".css": "Stylesheet",
    ".scss": "SCSS stylesheet",
    ".less": "LESS stylesheet",
    ".json": "JSON configuration",
    ".yaml": "YAML configuration",
    ".yml": "YAML configuration"
  };

  if (extHints[ext]) {
    return `${readableName} - ${extHints[ext]}`;
  }

  return `${readableName} in ${dirName || "root"}`;
}

/**
 * Infer component type from file path
 */
function inferComponentType(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  const fileName = filePath.split(/[/\\]/).pop() || "";

  if (lowerPath.includes("button")) return "button";
  if (lowerPath.includes("form")) return "form";
  if (lowerPath.includes("modal") || lowerPath.includes("dialog")) return "modal";
  // Hook files look like useAuth.ts / use-auth.ts — NOT "user/..." paths
  if (lowerPath.includes("hook") || /^use[A-Z_-]/.test(fileName)) return "hook";
  if (lowerPath.includes("service")) return "service";
  if (lowerPath.includes("api") || lowerPath.includes("endpoint")) return "api-endpoint";
  if (lowerPath.includes("util") || lowerPath.includes("helper")) return "utility";
  if (lowerPath.includes("config") || lowerPath.includes("constant")) return "config";
  if (lowerPath.includes("context") || lowerPath.includes("provider")) return "context";
  if (lowerPath.includes("store") || lowerPath.includes("slice")) return "state";
  if (lowerPath.includes("component")) return "component";
  if (lowerPath.includes("page") || lowerPath.includes("view")) return "page";
  if (lowerPath.includes("layout")) return "layout";
  if (lowerPath.includes("test") || lowerPath.includes("spec")) return "test";
  if (lowerPath.includes("route") || lowerPath.includes("router")) return "router";
  if (lowerPath.includes("middleware")) return "middleware";
  if (lowerPath.includes("controller")) return "controller";
  if (lowerPath.includes("model") || lowerPath.includes("schema")) return "model";

  return "unknown";
}

/**
 * Infer feature area from file path
 */
function inferFeatureArea(filePath: string): string {
  const lowerPath = filePath.toLowerCase();

  if (lowerPath.includes("auth") || lowerPath.includes("login") || lowerPath.includes("signup")) return "auth";
  if (lowerPath.includes("checkout") || lowerPath.includes("cart") || lowerPath.includes("payment")) return "checkout";
  if (lowerPath.includes("dashboard")) return "dashboard";
  if (lowerPath.includes("profile") || lowerPath.includes("account")) return "user-profile";
  if (lowerPath.includes("setting")) return "settings";
  if (lowerPath.includes("admin")) return "admin";
  if (lowerPath.includes("api")) return "api";
  if (lowerPath.includes("shared") || lowerPath.includes("common")) return "shared";
  if (lowerPath.includes("nav") || lowerPath.includes("header") || lowerPath.includes("footer")) return "navigation";
  if (lowerPath.includes("user")) return "user";
  if (lowerPath.includes("product")) return "product";
  if (lowerPath.includes("order")) return "order";
  if (lowerPath.includes("notification")) return "notifications";
  if (lowerPath.includes("message") || lowerPath.includes("chat")) return "messaging";
  if (lowerPath.includes("search")) return "search";

  // Try to extract from directory structure
  const parts = filePath.split(/[/\\]/);
  for (const part of parts) {
    if (part && !["src", "app", "components", "pages", "lib", "utils", "index"].includes(part.toLowerCase())) {
      const cleaned = part.toLowerCase().replace(/[^a-z0-9]/g, "-");
      if (cleaned.length > 2 && cleaned.length < 20) {
        return cleaned;
      }
    }
  }

  return "general";
}

/**
 * Generate description using the LLM with component type and feature area.
 * Only used when read_content=true — path-only indexing uses heuristics.
 */
async function generateDescriptionWithAI(
  filePath: string,
  content: string
): Promise<{ description: string; component_type: string; feature_area: string }> {
  const prompt = `Analyze this source file and extract metadata for codebase indexing.

File: ${filePath}
Content (first 2000 chars):
${content.slice(0, 2000)}

Return ONLY a JSON object with this structure:
{
  "description": "Brief 1-2 sentence description of purpose and functionality",
  "component_type": "type of component (e.g., 'button', 'form', 'api-endpoint', 'service', 'hook', 'util', 'config', 'page', 'modal', 'layout')",
  "feature_area": "business feature area (e.g., 'auth', 'checkout', 'dashboard', 'user-profile', 'settings', 'navigation')"
}`;

  try {
    const parsed = await generateJSON<{
      description?: unknown;
      component_type?: unknown;
      feature_area?: unknown;
    }>(prompt, {
      schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          component_type: { type: "string" },
          feature_area: { type: "string" }
        },
        required: ["description", "component_type", "feature_area"],
        additionalProperties: false
      },
      schemaName: "file_metadata"
    });

    if (parsed) {
      return {
        description:
          typeof parsed.description === "string" && parsed.description.trim()
            ? parsed.description.slice(0, 500)
            : generateDescriptionFromPath(filePath),
        component_type:
          typeof parsed.component_type === "string" && parsed.component_type.trim()
            ? parsed.component_type
            : inferComponentType(filePath),
        feature_area:
          typeof parsed.feature_area === "string" && parsed.feature_area.trim()
            ? parsed.feature_area
            : inferFeatureArea(filePath)
      };
    }
  } catch {
    // Fallback
  }

  return {
    description: generateDescriptionFromPath(filePath),
    component_type: inferComponentType(filePath),
    feature_area: inferFeatureArea(filePath)
  };
}

/**
 * Read file content for description generation.
 * Returns undefined for binary or oversized files.
 */
async function readContentSafely(fullPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_READ_BYTES) {
      return undefined;
    }
    const buffer = await fs.readFile(fullPath);
    // Binary sniff: NUL byte in the first 1KB
    const probe = buffer.subarray(0, 1024);
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) return undefined;
    }
    return buffer.toString("utf-8").slice(0, 3000);
  } catch {
    return undefined;
  }
}

/**
 * Recursively scan directory for files matching the glob patterns.
 * Reports whether the max_files limit cut the scan short.
 */
async function scanDirectory(
  dirPath: string,
  includePatterns: string[],
  excludePatterns: string[],
  maxFiles: number
): Promise<{ files: string[]; limitHit: boolean }> {
  const files: string[] = [];
  let limitHit = false;

  // Real glob matching (picomatch). `**/*.ts` should also match `file.ts`
  // at the root, so basename-style patterns get a second matcher.
  // dot:true so explicit dotfile/dot-dir patterns (e.g. ".github/**/*.yml",
  // "**/.eslintrc.js") actually work; heavy dot-dirs are skipped via
  // ALWAYS_SKIP_DIRS during traversal instead.
  const isIncluded = picomatch(includePatterns, { dot: true, nocase: true });
  const isIncludedBase = picomatch(
    includePatterns
      .filter(p => p.startsWith("**/"))
      .map(p => p.slice(3)),
    { dot: true, nocase: true }
  );
  const isExcluded =
    excludePatterns.length > 0
      ? picomatch(excludePatterns, { dot: true, nocase: true })
      : () => false;

  async function scan(currentPath: string): Promise<void> {
    if (files.length >= maxFiles) {
      limitHit = true;
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        limitHit = true;
        break;
      }

      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, "/");

      if (isExcluded(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!ALWAYS_SKIP_DIRS.has(entry.name.toLowerCase())) {
          await scan(fullPath);
        }
      } else if (entry.isFile()) {
        if (isIncluded(relativePath) || isIncludedBase(relativePath)) {
          files.push(relativePath);
        }
      }
    }
  }

  await scan(dirPath);
  return { files, limitHit };
}

/**
 * Execute the rlm_index_codebase tool
 */
export async function executeIndexCodebase(
  params: RLMIndexCodebaseInput
): Promise<ToolResult> {
  const projectName = params.project_name;
  const dirPath = params.directory_path;

  // Check if directory exists
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `'${dirPath}' is not a directory`,
            success: false
          }, null, 2)
        }],
        isError: true
      };
    }
  } catch {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `Directory not found: '${dirPath}'`,
          success: false
        }, null, 2)
      }],
      isError: true
    };
  }

  // Initialize project if it doesn't exist
  const exists = await projectExists(projectName);
  if (!exists) {
    await initializeProject(projectName, dirPath);
  }

  await updateLastAccessed(projectName);

  // Scan directory for files
  const { files, limitHit } = await scanDirectory(
    dirPath,
    params.file_patterns || [],
    params.exclude_patterns || [],
    params.max_files
  );

  if (files.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          message: "No matching files found in directory",
          directory: dirPath,
          patterns: params.file_patterns,
          hint: "Check that file_patterns match your project's languages (e.g. ['**/*.py'] for Python).",
          success: false
        }, null, 2)
      }]
    };
  }

  // Process files and generate descriptions.
  // read_content=true  → LLM description per file (bounded concurrency)
  // read_content=false → instant path heuristics, no LLM calls at all
  const useAI = params.read_content && isLLMAvailable();
  const errors: string[] = [];

  const fileEntries = (
    await mapWithConcurrency(files, INDEX_CONCURRENCY, async (relativePath) => {
      try {
        let metadata: { description: string; component_type: string; feature_area: string };

        if (useAI) {
          const content = await readContentSafely(path.join(dirPath, relativePath));
          metadata = content
            ? await generateDescriptionWithAI(relativePath, content)
            : {
                description: generateDescriptionFromPath(relativePath),
                component_type: inferComponentType(relativePath),
                feature_area: inferFeatureArea(relativePath)
              };
        } else {
          metadata = {
            description: generateDescriptionFromPath(relativePath),
            component_type: inferComponentType(relativePath),
            feature_area: inferFeatureArea(relativePath)
          };
        }

        // Extract keywords
        const pathKeywords = extractKeywordsFromPath(relativePath);
        const descKeywords = metadata.description
          .toLowerCase()
          .split(/[\W_]+/)
          .filter(w => w.length > 2 && !STOP_WORDS.has(w));

        const keywords = [...new Set([
          ...pathKeywords,
          ...descKeywords,
          ...(metadata.component_type ? [metadata.component_type.toLowerCase()] : []),
          ...(metadata.feature_area ? [metadata.feature_area.toLowerCase()] : [])
        ])].slice(0, 10);

        return {
          path: relativePath,
          description: metadata.description,
          keywords,
          component_type: metadata.component_type,
          feature_area: metadata.feature_area
        };
      } catch (error) {
        errors.push(`Failed to process ${relativePath}: ${error}`);
        return null;
      }
    })
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // Update file map
  const updatedPaths = await updateFileMap(projectName, fileEntries);

  // Create memory entry documenting the indexing
  const memory = await addMemory(projectName, {
    project_id: projectName,
    user_prompt: `Index codebase at ${dirPath}`,
    changes_summary: `Indexed ${fileEntries.length} files from ${dirPath}. File types: ${[...new Set(files.map(f => path.extname(f)))].join(", ")}`,
    files_modified: updatedPaths,
    keywords: ["index", "codebase", "scan", "filemap", "initialization"]
  });

  // Group files by type and area for verification
  const byComponentType: Record<string, number> = {};
  const byFeatureArea: Record<string, number> = {};
  const byExtension: Record<string, number> = {};

  for (const entry of fileEntries) {
    const ext = entry.path.split(".").pop() || "unknown";
    byExtension[ext] = (byExtension[ext] || 0) + 1;

    if (entry.component_type) {
      byComponentType[entry.component_type] = (byComponentType[entry.component_type] || 0) + 1;
    }
    if (entry.feature_area) {
      byFeatureArea[entry.feature_area] = (byFeatureArea[entry.feature_area] || 0) + 1;
    }
  }

  // Generate verification prompt
  const verificationPrompt = `Indexed ${fileEntries.length} files. Component types: ${Object.keys(byComponentType).join(", ") || "none classified"}. Feature areas: ${Object.keys(byFeatureArea).join(", ") || "none classified"}. Please verify by calling rlm_verify_index to confirm everything is indexed correctly.`;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        message: "Codebase indexed successfully",
        project_name: projectName,
        directory: dirPath,
        files_scanned: files.length,
        files_indexed: fileEntries.length,
        ai_descriptions: useAI,
        truncated: limitHit,
        truncation_warning: limitHit
          ? `Scan stopped at the max_files limit (${params.max_files}) — the codebase has MORE files that were NOT indexed. Re-run with a higher max_files or narrower file_patterns to cover the rest.`
          : undefined,
        memory_id: memory.id,
        files_by_extension: byExtension,
        files_by_component_type: byComponentType,
        files_by_feature_area: byFeatureArea,
        errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
        success: true,
        sample_files: fileEntries.slice(0, 5).map(f => ({
          path: f.path,
          description: f.description.slice(0, 100) + (f.description.length > 100 ? "..." : ""),
          keywords: f.keywords,
          component_type: f.component_type,
          feature_area: f.feature_area
        })),
        _verification_required: true,
        _next_step: "Call rlm_verify_index to confirm the indexing is complete and check for any gaps.",
        _verification_prompt: verificationPrompt
      }, null, 2)
    }]
  };
}
