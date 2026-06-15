/**
 * rlm_smart_memory tool implementation
 *
 * Enhanced memory creation with better context understanding.
 * The AI agent provides detailed change context, and the LLM generates:
 * - Better keywords for semantic search
 * - Component type and feature area classification
 * - Edit history tracking
 *
 * The agent's full changes_context is ALWAYS persisted verbatim
 * (full_context) — the LLM summary is a convenience, never the only record.
 */

import { type RLMSmartMemoryInput } from "../schemas/index.js";
import {
  addMemory,
  updateFileMap,
  deleteFileFromMap,
  projectExists,
  updateLastAccessed,
  normalizeFilePath
} from "../services/database.js";
import { generateJSON, extractKeywordsFallback, isLLMAvailable } from "../services/llm.js";
import type { ToolResult } from "../types.js";

interface FileMetadata {
  description: string;
  component_type: string;
  feature_area: string;
  keywords: string[];
}

/**
 * Use the LLM to extract rich metadata from change context
 */
async function extractRichMetadata(
  userPrompt: string,
  changesContext: string,
  filesModified: Array<{ path: string; change_type: string; change_summary: string }>
): Promise<{
  keywords: string[];
  fileMetadata: Map<string, FileMetadata>;
  memorySummary: string;
  usedFallback: boolean;
}> {
  const filesList = filesModified.map(f =>
    `- ${f.path} (${f.change_type}): ${f.change_summary}`
  ).join("\n");

  const prompt = `Analyze this code change and extract metadata for semantic search and future recall.

USER REQUEST: "${userPrompt}"

CHANGES MADE: "${changesContext}"

FILES MODIFIED:
${filesList}

Based on this information, extract:
1. Keywords for semantic search (technical terms, features, concepts)
2. A concise summary of what was accomplished
3. For each file listed above:
   - Brief description of what it does
   - Component type (e.g., "button", "form", "modal", "api-endpoint", "service", "hook", "util", "config")
   - Feature area (e.g., "auth", "checkout", "dashboard", "user-profile", "settings")
   - File-specific keywords

Return ONLY a JSON object with this exact structure:
{
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "memory_summary": "Concise summary of what was accomplished",
  "files": [
    {
      "path": "path/to/file.ts",
      "description": "Brief description",
      "component_type": "type",
      "feature_area": "area",
      "keywords": ["kw1", "kw2"]
    }
  ]
}

IMPORTANT:
- Use the exact file paths from the FILES MODIFIED list
- Keywords should be specific and useful for future search
- Avoid generic words like "file", "code", "function", "this", "that"
- Component types should be specific: "submit-button" is better than "button"
- Feature areas should reflect the business domain`;

  if (isLLMAvailable()) {
    try {
      const parsed = await generateJSON<{
        keywords?: unknown;
        memory_summary?: unknown;
        files?: unknown;
      }>(prompt, {
        schema: {
          type: "object",
          properties: {
            keywords: { type: "array", items: { type: "string" } },
            memory_summary: { type: "string" },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  description: { type: "string" },
                  component_type: { type: "string" },
                  feature_area: { type: "string" },
                  keywords: { type: "array", items: { type: "string" } }
                },
                required: ["path", "description", "component_type", "feature_area", "keywords"],
                additionalProperties: false
              }
            }
          },
          required: ["keywords", "memory_summary", "files"],
          additionalProperties: false
        },
        schemaName: "change_metadata"
      });

      if (parsed) {
        // Shape-validate everything coming back from the model
        const keywords = Array.isArray(parsed.keywords)
          ? parsed.keywords.filter((k): k is string => typeof k === "string")
          : [];
        const memorySummary =
          typeof parsed.memory_summary === "string" && parsed.memory_summary.trim()
            ? parsed.memory_summary
            : changesContext;

        // Key file metadata by NORMALIZED path so model formatting drift
        // (backslashes, ./ prefixes, case) still matches the agent's paths
        const fileMetadata = new Map<string, FileMetadata>();
        if (Array.isArray(parsed.files)) {
          for (const f of parsed.files) {
            if (!f || typeof f !== "object") continue;
            const entry = f as Record<string, unknown>;
            if (typeof entry.path !== "string") continue;
            fileMetadata.set(normalizeFilePath(entry.path).toLowerCase(), {
              description: typeof entry.description === "string" ? entry.description : "",
              component_type: typeof entry.component_type === "string" ? entry.component_type : "",
              feature_area: typeof entry.feature_area === "string" ? entry.feature_area : "",
              keywords: Array.isArray(entry.keywords)
                ? entry.keywords.filter((k): k is string => typeof k === "string")
                : []
            });
          }
        }

        if (keywords.length > 0 || fileMetadata.size > 0) {
          return { keywords, fileMetadata, memorySummary, usedFallback: false };
        }
      }
    } catch {
      // Fall through to heuristics
    }
  }

  // Fallback: heuristics — keywords with stop-word filtering, full context
  // preserved as the summary (never truncated)
  const allText = `${userPrompt} ${changesContext} ${filesModified.map(f => f.change_summary).join(" ")}`;
  const keywords = extractKeywordsFallback(allText);

  const fileMetadata = new Map<string, FileMetadata>();
  for (const file of filesModified) {
    fileMetadata.set(normalizeFilePath(file.path).toLowerCase(), {
      description: `${file.change_type}: ${file.change_summary}`,
      component_type: inferComponentType(file.path),
      feature_area: inferFeatureArea(file.path),
      keywords: extractKeywordsFromPath(file.path)
    });
  }

  return {
    keywords,
    fileMetadata,
    memorySummary: changesContext,
    usedFallback: true
  };
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

  // Try to extract from directory structure
  const parts = filePath.split(/[/\\]/);
  for (const part of parts) {
    if (part && !["src", "app", "components", "pages", "lib", "utils", "index"].includes(part.toLowerCase())) {
      return part.toLowerCase().replace(/[^a-z0-9]/g, "-");
    }
  }

  return "general";
}

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
      .filter(w => w.length > 2);
    keywords.push(...words);
  }

  return [...new Set(keywords)].slice(0, 5);
}

/**
 * Execute the rlm_smart_memory tool
 */
export async function executeSmartMemory(
  params: RLMSmartMemoryInput
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

  await updateLastAccessed(projectName);

  // Extract rich metadata FIRST (the LLM call can take many seconds) —
  // the database is read and written afterwards under the project lock,
  // so concurrent writes are never lost.
  const metadata = await extractRichMetadata(
    params.user_prompt,
    params.changes_context,
    params.files_modified
  );

  // Agent-provided areas/features go FIRST so a verbose model can never
  // push them off the end of the keyword list.
  const keywords = [
    ...new Set([
      ...(params.affected_areas || []),
      ...(params.new_features || []).map(f => f.toLowerCase().replace(/\s+/g, "-")),
      ...metadata.keywords
    ])
  ].slice(0, 15);

  // Create the memory entry (locked, atomic). Full context is preserved
  // verbatim — the LLM summary is only a search/display convenience.
  const memory = await addMemory(projectName, {
    project_id: projectName,
    user_prompt: params.user_prompt,
    changes_summary: metadata.memorySummary,
    full_context: params.changes_context,
    files_modified: params.files_modified.map(f => normalizeFilePath(f.path)),
    keywords
  });

  // Update the file map with rich metadata + edit history.
  const deletedFiles = params.files_modified.filter(f => f.change_type === "deleted");
  const activeFiles = params.files_modified.filter(f => f.change_type !== "deleted");

  const lookupMeta = (filePath: string): FileMetadata | undefined =>
    metadata.fileMetadata.get(normalizeFilePath(filePath).toLowerCase());

  const updatedPaths = await updateFileMap(
    projectName,
    activeFiles.map(file => {
      const meta = lookupMeta(file.path);
      return {
        path: file.path,
        description: meta?.description || file.change_summary,
        keywords: meta?.keywords?.length ? meta.keywords : extractKeywordsFromPath(file.path),
        component_type: meta?.component_type || inferComponentType(file.path),
        feature_area: meta?.feature_area || inferFeatureArea(file.path),
        edit_summary: file.change_summary,
        memory_id: memory.id
      };
    })
  );

  // Deleted files leave the map entirely (consistent with rlm_manage_sitemap);
  // the deletion itself stays on record in the memory entry.
  const removedPaths: string[] = [];
  for (const file of deletedFiles) {
    const removed = await deleteFileFromMap(projectName, file.path);
    if (removed) {
      removedPaths.push(normalizeFilePath(file.path));
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        message: "Memory created with rich metadata",
        memory_id: memory.id,
        timestamp: memory.timestamp,
        ai_powered: !metadata.usedFallback,
        keywords_extracted: keywords,
        files_updated: updatedPaths.map(path => {
          const meta = lookupMeta(path);
          return {
            path,
            component_type: meta?.component_type || inferComponentType(path),
            feature_area: meta?.feature_area || inferFeatureArea(path)
          };
        }),
        files_removed_from_map: removedPaths,
        new_features_tracked: params.new_features || [],
        affected_areas: params.affected_areas || [],
        _confirmation: "The changes have been recorded. Future queries about these files will include this edit history."
      }, null, 2)
    }]
  };
}
