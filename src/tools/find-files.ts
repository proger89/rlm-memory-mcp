/**
 * find_files_by_intent tool implementation
 * Semantic file discovery - replaces grep/find with intent-based search
 */

import { type FindFilesByIntentInput } from "../schemas/index.js";
import {
  getFileMap,
  projectExists,
  updateLastAccessed,
  normalizeFilePath
} from "../services/database.js";
import { matchFilesToIntent } from "../services/llm.js";
import { ResponseFormat, type FindFilesResult, type FileMapEntry, type ToolResult } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

/**
 * Format results as markdown
 */
function formatMarkdown(result: FindFilesResult): string {
  const lines: string[] = [
    `# File Search Results`,
    ``,
    `**Query:** ${result.query}`,
    `**Files Found:** ${result.total}`,
    ``
  ];

  if (result.ai_reasoning) {
    lines.push(`**AI Reasoning:** ${result.ai_reasoning}`);
    lines.push("");
  }

  if (result.files.length === 0) {
    lines.push("*No matching files found in the project map.*");
    lines.push("");
    lines.push("**Suggestions:**");
    lines.push("- The file map might not include this file yet");
    lines.push("- Try using more general keywords");
    lines.push("- Use rlm_index_codebase to scan the codebase, or add files via rlm_smart_memory after changes");
    return lines.join("\n");
  }

  lines.push("## Matching Files");
  lines.push("");

  for (const file of result.files) {
    lines.push(`### \`${file.path}\``);
    lines.push("");
    lines.push(`${file.description || "No description"}`);
    lines.push("");
    const keywords = file.keywords || [];
    if (keywords.length > 0) {
      lines.push(`**Keywords:** ${keywords.join(", ")}`);
    }
    lines.push(`**Last Modified:** ${file.last_modified ? new Date(file.last_modified).toLocaleDateString() : "unknown"}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Execute the find_files_by_intent tool
 */
export async function executeFindFiles(
  params: FindFilesByIntentInput
): Promise<ToolResult> {
  const projectName = params.project_name;

  // Check if project exists
  const exists = await projectExists(projectName);
  if (!exists) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: `Project '${projectName}' not found. Use rlm_init to create it first.`
        }, null, 2)
      }],
      isError: true
    };
  }

  // Update last accessed
  await updateLastAccessed(projectName);

  // Get file map
  const fileMap = await getFileMap(projectName);

  if (fileMap.length === 0) {
    const result: FindFilesResult = {
      files: [],
      total: 0,
      query: params.user_prompt,
      ai_reasoning: "No files in project map yet. Use rlm_index_codebase to scan the codebase first, or add files via rlm_smart_memory after making changes."
    };

    const textContent = params.response_format === ResponseFormat.MARKDOWN
      ? formatMarkdown(result)
      : JSON.stringify(result, null, 2);

    return {
      content: [{ type: "text", text: textContent }]
    };
  }

  // Use the LLM to match intent to files with enhanced data
  const aiResult = await matchFilesToIntent(
    params.user_prompt,
    fileMap.map(f => ({
      path: f.path,
      description: f.description || "",
      keywords: f.keywords || [],
      component_type: f.component_type,
      feature_area: f.feature_area,
      edit_history: f.edit_history
    }))
  );

  // Build result with full file info — match by normalized path so
  // separator/case drift never silently drops results.
  const byNormalizedPath = new Map(
    fileMap.map(f => [normalizeFilePath(f.path).toLowerCase(), f])
  );
  const matchedFiles: FileMapEntry[] = aiResult.files
    .map(p => byNormalizedPath.get(normalizeFilePath(p).toLowerCase()))
    .filter((f): f is FileMapEntry => f !== undefined)
    .slice(0, params.limit);

  // Format output, iteratively shrinking until under the character limit
  let files = matchedFiles;
  let truncated = false;
  let textContent: string;

  for (;;) {
    const result: FindFilesResult = {
      files,
      total: files.length,
      query: params.user_prompt,
      ai_reasoning: aiResult.reasoning
    };

    if (params.response_format === ResponseFormat.MARKDOWN) {
      textContent = formatMarkdown(result);
      if (truncated) {
        textContent += `\n\n*Note: Results truncated (${matchedFiles.length - files.length} of ${matchedFiles.length} matches omitted). Be more specific in your query.*`;
      }
    } else {
      textContent = JSON.stringify(
        truncated
          ? { ...result, truncated: true, truncation_message: `Results truncated due to size: showing ${files.length} of ${matchedFiles.length} matches.` }
          : result,
        null,
        2
      );
    }

    if (textContent.length <= CHARACTER_LIMIT || files.length === 0) {
      break;
    }
    truncated = true;
    files = files.slice(0, Math.max(0, Math.floor(files.length / 2)));
  }

  return {
    content: [{ type: "text", text: textContent }]
  };
}
