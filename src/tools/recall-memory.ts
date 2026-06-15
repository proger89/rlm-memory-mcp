/**
 * recall_memory tool implementation
 * Retrieves project memory and context based on keywords
 */

import { type RecallMemoryInput } from "../schemas/index.js";
import {
  loadDatabase,
  searchMemories,
  projectExists,
  updateLastAccessed
} from "../services/database.js";
import { ResponseFormat, type RecallMemoryResult, type ToolResult } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

/**
 * Format memories as markdown
 */
function formatMarkdown(result: RecallMemoryResult): string {
  const lines: string[] = [
    `# Project Memory Recall`,
    ``,
    `**Project ID:** ${result.project_id}`,
    `**Keywords Searched:** ${result.keywords_searched.join(", ")}`,
    `**Memories Found:** ${result.total}`,
    ``
  ];

  if (result.memories.length === 0) {
    lines.push("*No matching memories found. This might be a new topic for this project.*");
    return lines.join("\n");
  }

  lines.push("## Relevant Memories");
  lines.push("");

  for (const memory of result.memories) {
    const date = new Date(memory.timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    lines.push(`### ${memory.id} (${date})`);
    lines.push("");
    lines.push(`**Original Request:** ${memory.user_prompt}`);
    lines.push("");
    lines.push(`**Changes Made:**`);
    lines.push(memory.changes_summary);
    lines.push("");

    if (memory.files_modified.length > 0) {
      lines.push(`**Files Modified:**`);
      for (const file of memory.files_modified) {
        lines.push(`- \`${file}\``);
      }
      lines.push("");
    }

    const keywords = memory.keywords || [];
    if (keywords.length > 0) {
      lines.push(`**Tags:** ${keywords.join(", ")}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Execute the recall_memory tool
 */
export async function executeRecallMemory(
  params: RecallMemoryInput
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

  // Load database and search
  const database = await loadDatabase(projectName);
  const allMemories = await searchMemories(projectName, params.keywords, params.limit);

  // Format output, iteratively shrinking until under the character limit
  let memories = allMemories;
  let truncated = false;
  let textContent: string;

  for (;;) {
    const result: RecallMemoryResult = {
      memories,
      total: memories.length,
      project_id: database.config.project_id,
      keywords_searched: params.keywords
    };

    if (params.response_format === ResponseFormat.MARKDOWN) {
      textContent = formatMarkdown(result);
      if (truncated) {
        textContent += `\n\n*Note: Results truncated (showing ${memories.length} of ${allMemories.length}). Use more specific keywords.*`;
      }
    } else {
      textContent = JSON.stringify(
        truncated
          ? { ...result, truncated: true, truncation_message: `Results truncated: showing ${memories.length} of ${allMemories.length}. Use more specific keywords.` }
          : result,
        null,
        2
      );
    }

    if (textContent.length <= CHARACTER_LIMIT || memories.length === 0) {
      break;
    }
    truncated = true;
    memories = memories.slice(0, Math.max(0, Math.floor(memories.length / 2)));
  }

  return {
    content: [{ type: "text", text: textContent }]
  };
}
