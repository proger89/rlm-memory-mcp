/**
 * manage_sitemap tool implementation
 * Allows AI agents to manage sitemap entries when files are moved, deleted, or updated
 */

import { type RLMManageSitemapInput } from "../schemas/index.js";
import {
  loadDatabase,
  saveFileMap,
  projectExists,
  updateLastAccessed,
  withProjectLock,
  findFileIndex,
  normalizeFilePath
} from "../services/database.js";
import type { ToolResult } from "../types.js";

interface OperationResult {
  action: string;
  file_path: string;
  success: boolean;
  message: string;
  new_path?: string;
}

/**
 * Execute the manage_sitemap tool
 */
export async function executeManageSitemap(
  params: RLMManageSitemapInput
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

  // Apply all operations under the project lock (atomic read-modify-write).
  // IMPORTANT: entries are REPLACED with new objects, never mutated in
  // place — the loaded objects may be shared with the read cache.
  const { results, remaining } = await withProjectLock(projectName, async () => {
    const database = await loadDatabase(projectName, true);
    const fileMap = [...database.file_map];
    const opResults: OperationResult[] = [];
    let modifiedCount = 0;

    for (const op of params.operations) {
      const result: OperationResult = {
        action: op.action,
        file_path: op.file_path,
        success: false,
        message: ""
      };

      // Find the file entry — normalized matching (separators/case)
      const fileIndex = findFileIndex(fileMap, op.file_path);

      switch (op.action) {
        case "delete": {
          if (fileIndex === -1) {
            result.message = `File not found in sitemap: ${op.file_path}`;
          } else {
            fileMap.splice(fileIndex, 1);
            result.success = true;
            result.message = `Deleted from sitemap: ${op.file_path}`;
            modifiedCount++;
          }
          break;
        }

        case "move": {
          if (!op.new_path) {
            result.message = `'new_path' is required for 'move' action`;
          } else if (fileIndex === -1) {
            result.message = `File not found in sitemap: ${op.file_path}`;
          } else {
            const newPath = normalizeFilePath(op.new_path);
            // Check if new path already exists
            const existingNewPath = findFileIndex(fileMap, newPath);
            if (existingNewPath !== -1 && existingNewPath !== fileIndex) {
              result.message = `Target path already exists in sitemap: ${newPath}`;
            } else {
              // Replace with a new object (never mutate the cached entry)
              fileMap[fileIndex] = {
                ...fileMap[fileIndex],
                path: newPath,
                last_modified: new Date().toISOString()
              };
              result.success = true;
              result.new_path = newPath;
              result.message = `Moved in sitemap: ${op.file_path} → ${newPath}`;
              modifiedCount++;
            }
          }
          break;
        }

        case "update": {
          if (fileIndex === -1) {
            result.message = `File not found in sitemap: ${op.file_path}`;
          } else if (!op.updates) {
            result.message = `'updates' object is required for 'update' action`;
          } else {
            const updates = op.updates;
            const applied: Record<string, unknown> = {};
            const changedFields: string[] = [];

            if (updates.description !== undefined) {
              applied.description = updates.description;
              changedFields.push("description");
            }
            if (updates.keywords !== undefined) {
              applied.keywords = updates.keywords;
              changedFields.push("keywords");
            }
            if (updates.component_type !== undefined) {
              applied.component_type = updates.component_type;
              changedFields.push("component_type");
            }
            if (updates.feature_area !== undefined) {
              applied.feature_area = updates.feature_area;
              changedFields.push("feature_area");
            }

            if (changedFields.length > 0) {
              // Replace with a new object (never mutate the cached entry)
              fileMap[fileIndex] = {
                ...fileMap[fileIndex],
                ...applied,
                last_modified: new Date().toISOString()
              };
              result.success = true;
              result.message = `Updated ${op.file_path}: ${changedFields.join(", ")}`;
              modifiedCount++;
            } else {
              result.message = `No fields to update for ${op.file_path}`;
            }
          }
          break;
        }
      }

      opResults.push(result);
    }

    // Save changes if any modifications were made
    if (modifiedCount > 0) {
      await saveFileMap(projectName, fileMap);
    }

    return { results: opResults, remaining: fileMap.length };
  });

  const successCount = results.filter(r => r.success).length;
  const failCount = results.length - successCount;

  const response = {
    message: `Sitemap management complete`,
    project_name: projectName,
    summary: {
      total_operations: results.length,
      successful: successCount,
      failed: failCount,
      sitemap_entries_remaining: remaining
    },
    results
  };

  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }]
  };
}
