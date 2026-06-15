/**
 * rlm_init, rlm_status, and rlm_list_projects tool implementations
 */

import { type RLMInitInput, type RLMStatusInput } from "../schemas/index.js";
import {
  initializeProject,
  loadDatabase,
  projectExists,
  updateLastAccessed,
  listProjects,
  getProjectPath,
  sanitizeProjectName
} from "../services/database.js";
import { ResponseFormat } from "../types.js";
import { PROJECTS_DIR } from "../constants.js";

/**
 * Execute the rlm_init tool
 */
export async function executeInit(
  params: RLMInitInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const projectName = params.project_name;
  const safeName = sanitizeProjectName(projectName);

  // Check if already initialized
  const exists = await projectExists(projectName);
  if (exists) {
    const db = await loadDatabase(projectName);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          message: "Project already exists",
          project_id: db.config.project_id,
          name: safeName,
          storage_path: getProjectPath(projectName),
          working_directory: db.config.root_path,
          created_at: db.config.created_at,
          memory_count: db.memory_log.length,
          file_count: db.file_map.length
        }, null, 2)
      }]
    };
  }

  // Initialize the project
  const config = await initializeProject(projectName, params.working_directory);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        message: "Project initialized successfully",
        project_id: config.project_id,
        name: config.name,
        storage_path: getProjectPath(projectName),
        working_directory: config.root_path,
        created_at: config.created_at
      }, null, 2)
    }]
  };
}

/**
 * Execute the rlm_status tool
 */
export async function executeStatus(
  params: RLMStatusInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const projectName = params.project_name;

  // Check if project exists
  const exists = await projectExists(projectName);
  if (!exists) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          exists: false,
          project_name: projectName,
          message: "Project not found. Use rlm_init to create it."
        }, null, 2)
      }]
    };
  }

  // Update last accessed
  await updateLastAccessed(projectName);

  // Load database
  const db = await loadDatabase(projectName);

  const summary = {
    project_id: db.config.project_id,
    name: db.config.name,
    storage_path: getProjectPath(projectName),
    working_directory: db.config.root_path,
    memory_count: db.memory_log.length,
    file_count: db.file_map.length,
    last_accessed: db.config.last_accessed
  };

  // Get recent memories summary (copy before sorting — never mutate the
  // shared cached array)
  const recentMemories = [...db.memory_log]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5)
    .map(m => ({
      id: m.id,
      timestamp: m.timestamp,
      summary: m.changes_summary.slice(0, 100) + (m.changes_summary.length > 100 ? "..." : "")
    }));

  // Get file map summary
  const topFiles = db.file_map.slice(0, 10).map(f => ({
    path: f.path,
    description: f.description.slice(0, 80) + (f.description.length > 80 ? "..." : "")
  }));

  let textContent: string;
  if (params.response_format === ResponseFormat.MARKDOWN) {
    const lines = [
      `# RLM Project Status`,
      ``,
      `**Project:** ${summary.name}`,
      `**ID:** ${summary.project_id}`,
      `**Storage:** ${summary.storage_path}`,
      `**Working Directory:** ${summary.working_directory}`,
      `**Last Accessed:** ${new Date(summary.last_accessed).toLocaleString()}`,
      ``,
      `## Statistics`,
      `- **Memories:** ${summary.memory_count}`,
      `- **Files in Map:** ${summary.file_count}`,
      ``
    ];

    if (recentMemories.length > 0) {
      lines.push(`## Recent Memories`);
      lines.push(``);
      for (const m of recentMemories) {
        lines.push(`- **${m.id}** (${new Date(m.timestamp).toLocaleDateString()}): ${m.summary}`);
      }
      lines.push(``);
    }

    if (topFiles.length > 0) {
      lines.push(`## File Map (Top ${topFiles.length})`);
      lines.push(``);
      for (const f of topFiles) {
        lines.push(`- \`${f.path}\`: ${f.description}`);
      }
    }

    textContent = lines.join("\n");
  } else {
    textContent = JSON.stringify({
      ...summary,
      exists: true,
      recent_memories: recentMemories,
      top_files: topFiles
    }, null, 2);
  }

  return {
    content: [{ type: "text", text: textContent }]
  };
}

/**
 * Execute the rlm_list_projects tool
 */
export async function executeListProjects(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const projects = await listProjects();

  const result = {
    total: projects.length,
    projects_directory: PROJECTS_DIR,
    projects: projects.map(p => ({
      name: p.name,
      project_id: p.project_id,
      memory_count: p.memory_count,
      file_count: p.file_count,
      working_directory: p.root_path,
      last_accessed: p.last_accessed
    }))
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2)
    }]
  };
}
