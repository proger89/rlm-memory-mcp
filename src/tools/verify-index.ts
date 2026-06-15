/**
 * rlm_verify_index tool implementation
 *
 * After indexing, this tool provides verification for the AI agent.
 * It asks "Is this everything? Are you sure?" with details about what was indexed.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { type RLMVerifyIndexInput } from "../schemas/index.js";
import {
  loadDatabase,
  projectExists,
  updateLastAccessed
} from "../services/database.js";
import { generateJSON, isLLMAvailable } from "../services/llm.js";
import type { FileMapEntry, ToolResult } from "../types.js";

/**
 * Group files by component type
 */
function groupByComponentType(files: FileMapEntry[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};

  for (const file of files) {
    const type = file.component_type || "unclassified";
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(file.path);
  }

  return groups;
}

/**
 * Group files by feature area
 */
function groupByFeatureArea(files: FileMapEntry[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};

  for (const file of files) {
    const area = file.feature_area || "general";
    if (!groups[area]) {
      groups[area] = [];
    }
    groups[area].push(file.path);
  }

  return groups;
}

/**
 * Group files by extension
 */
function groupByExtension(files: FileMapEntry[]): Record<string, number> {
  const groups: Record<string, number> = {};

  for (const file of files) {
    const ext = file.path.split(".").pop()?.toLowerCase() || "unknown";
    groups[ext] = (groups[ext] || 0) + 1;
  }

  return groups;
}

/**
 * Heuristic gap checks (also the LLM fallback)
 */
function detectMissingFilesHeuristic(
  files: FileMapEntry[],
  expectedFeatures?: string[]
): string[] {
  const missing: string[] = [];

  // Check for tests
  const hasComponents = files.some(f => f.component_type && f.component_type !== "unknown");
  const hasTests = files.some(f => f.path.includes("test") || f.path.includes("spec"));
  if (hasComponents && !hasTests) {
    missing.push("No test files found - consider indexing test directories");
  }

  // Check expected features (all fields defensive — entries may lack descriptions)
  if (expectedFeatures) {
    for (const feature of expectedFeatures) {
      const needle = feature.toLowerCase();
      const found = files.some(f =>
        (f.path || "").toLowerCase().includes(needle) ||
        (f.description || "").toLowerCase().includes(needle) ||
        (f.feature_area || "").toLowerCase().includes(needle) ||
        (f.keywords || []).some(k => k.toLowerCase().includes(needle))
      );
      if (!found) {
        missing.push(`Expected feature "${feature}" not found in indexed files`);
      }
    }
  }

  return missing;
}

/**
 * Use the LLM to detect potentially missing files
 */
async function detectMissingFiles(
  files: FileMapEntry[],
  expectedFeatures?: string[]
): Promise<string[]> {
  if (!isLLMAvailable()) {
    return detectMissingFilesHeuristic(files, expectedFeatures);
  }

  // Cap the path list so the prompt stays bounded on big projects
  const filesList = files.slice(0, 400).map(f => f.path).join("\n");
  const omitted = files.length > 400 ? `\n... and ${files.length - 400} more files (omitted)` : "";
  const featureAreas = [...new Set(files.map(f => f.feature_area).filter(Boolean))];
  const componentTypes = [...new Set(files.map(f => f.component_type).filter(Boolean))];

  const prompt = `Analyze this list of indexed files from a codebase and identify what might be MISSING.

INDEXED FILES:
${filesList}${omitted}

FEATURE AREAS FOUND: ${featureAreas.join(", ") || "none classified"}
COMPONENT TYPES FOUND: ${componentTypes.join(", ") || "none classified"}
${expectedFeatures ? `\nEXPECTED FEATURES: ${expectedFeatures.join(", ")}` : ""}

Based on common project structures and the files present, identify:
1. Typical files that are usually present but seem to be missing
2. If expected features were provided, check if they're represented in the files

Examples of potentially missing files:
- If there are components but no tests
- If there's auth but no logout
- If there's a form but no validation

Return ONLY a JSON object: { "missing": ["Description of missing item 1", "..."] }
If nothing seems to be missing, return { "missing": [] }`;

  try {
    const parsed = await generateJSON<{ missing?: unknown }>(prompt, {
      schema: {
        type: "object",
        properties: {
          missing: { type: "array", items: { type: "string" } }
        },
        required: ["missing"],
        additionalProperties: false
      },
      schemaName: "index_gaps"
    });

    if (parsed && Array.isArray(parsed.missing)) {
      return parsed.missing.filter((m): m is string => typeof m === "string");
    }
  } catch {
    // Fallback
  }

  return detectMissingFilesHeuristic(files, expectedFeatures);
}

/**
 * REAL verification: check that indexed files still exist on disk.
 * Uses the project's recorded root path; skips silently when unavailable.
 */
async function findFilesMissingOnDisk(
  rootPath: string | undefined,
  files: FileMapEntry[]
): Promise<string[] | null> {
  if (!rootPath) return null;
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null; // Root path not accessible from this machine
  }

  // Only check entries that are relative paths — absolute entries would
  // produce garbage when joined onto rootPath.
  const checkable = files.filter(f => !path.isAbsolute(f.path));
  if (checkable.length === 0) return null;

  const missing: string[] = [];
  // Bounded concurrency for large maps
  const batchSize = 25;
  for (let i = 0; i < checkable.length; i += batchSize) {
    const batch = checkable.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async f => {
        try {
          await fs.access(path.join(rootPath, f.path));
          return null;
        } catch {
          return f.path;
        }
      })
    );
    missing.push(...results.filter((p): p is string => p !== null));
  }

  // If EVERY file is "missing", the map was almost certainly indexed
  // relative to a different base directory than root_path — that's a
  // path-base mismatch, not 100% deleted files. Don't report noise.
  if (missing.length === checkable.length) {
    return null;
  }
  return missing;
}

/**
 * Generate confirmation prompt for the AI agent
 */
function generateConfirmationPrompt(
  fileCount: number,
  byType: Record<string, number>,
  byFeature: Record<string, string[]>,
  missing: string[]
): string {
  const lines: string[] = [
    `I have indexed ${fileCount} files in this project.`,
    "",
    "File types breakdown:",
    ...Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => `  - .${ext}: ${count} files`),
    "",
    "Feature areas identified:",
    ...Object.entries(byFeature)
      .slice(0, 10)
      .map(([area, files]) => `  - ${area}: ${files.length} files`)
  ];

  if (missing.length > 0) {
    lines.push("");
    lines.push("POTENTIAL GAPS DETECTED:");
    for (const item of missing) {
      lines.push(`  ⚠️ ${item}`);
    }
  }

  lines.push("");
  lines.push("Is this everything you expected? Should I index additional directories or file types?");

  return lines.join("\n");
}

/**
 * Execute the rlm_verify_index tool
 */
export async function executeVerifyIndex(
  params: RLMVerifyIndexInput
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

  // Load database
  const database = await loadDatabase(projectName);
  const fileMap = database.file_map;

  if (fileMap.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: "No files have been indexed yet.",
          files_indexed: 0,
          confirmation_prompt: "No files have been indexed. Would you like me to run rlm_index_codebase to scan the project directory?"
        }, null, 2)
      }]
    };
  }

  // Analyze indexed files
  const byType = groupByExtension(fileMap);
  const byComponent = groupByComponentType(fileMap);
  const byFeature = groupByFeatureArea(fileMap);

  // Detect potentially missing files (LLM analysis or heuristics)
  const potentialMissing = await detectMissingFiles(fileMap, params.expected_features);

  // REAL check: indexed files that no longer exist on disk (stale entries)
  const missingOnDisk = await findFilesMissingOnDisk(database.config?.root_path, fileMap);
  if (missingOnDisk && missingOnDisk.length > 0) {
    potentialMissing.push(
      `${missingOnDisk.length} indexed file(s) were not found on disk (relative to the project root). If they were really deleted/renamed, sync the map with rlm_manage_sitemap; if they were indexed from a different base directory, leave them as-is: ${missingOnDisk.slice(0, 10).join(", ")}${missingOnDisk.length > 10 ? ", ..." : ""}`
    );
  }

  // Generate confirmation prompt
  const confirmationPrompt = generateConfirmationPrompt(
    fileMap.length,
    byType,
    byFeature,
    potentialMissing
  );

  if (params.report_format === "detailed") {
    // Detailed report
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          files_indexed: fileMap.length,
          files_by_extension: byType,
          files_by_component_type: byComponent,
          files_by_feature_area: byFeature,
          sample_files: fileMap.slice(0, 20).map(f => ({
            path: f.path,
            description: (f.description || "").slice(0, 100),
            component_type: f.component_type,
            feature_area: f.feature_area,
            keywords: (f.keywords || []).slice(0, 5)
          })),
          missing_on_disk: missingOnDisk ?? undefined,
          potential_gaps: potentialMissing,
          confirmation_prompt: confirmationPrompt,
          _instructions: "Review the indexed files above. If anything is missing, use rlm_index_codebase with different patterns or directories."
        }, null, 2)
      }]
    };
  }

  // Summary report
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        files_indexed: fileMap.length,
        top_extensions: Object.entries(byType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([ext, count]) => ({ extension: ext, count })),
        feature_areas: Object.keys(byFeature),
        component_types: Object.keys(byComponent),
        missing_on_disk: missingOnDisk ?? undefined,
        potential_gaps: potentialMissing,
        confirmation_prompt: confirmationPrompt,
        _verification_required: potentialMissing.length > 0 ? "Please verify the gaps listed above" : "Index looks complete"
      }, null, 2)
    }]
  };
}
