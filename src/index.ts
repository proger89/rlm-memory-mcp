#!/usr/bin/env node
/**
 * RLM Memory MCP Server
 *
 * This is the MCP server that AI agents (Claude Code, Codex, Gemini CLI,
 * Cursor, ...) connect to. It provides tools for persistent memory and
 * semantic file discovery.
 *
 * Tools (11):
 * - rlm_query: PRIMARY — ask for relevant files + context at task start
 * - rlm_smart_memory: MANDATORY — record changes at task end
 * - rlm_init / rlm_status / rlm_list_projects: project management
 * - rlm_index_codebase / rlm_verify_index: build & verify the file map
 * - rlm_manage_sitemap: keep the file map in sync with renames/deletes
 * - rlm_recall_memory / rlm_find_files_by_intent / rlm_create_memory: legacy
 */

import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

// Load .env from the MCP server directory (not CWD)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: envPath });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initLLM } from "./services/llm.js";
import { z } from "zod";

// Import tool executors
import { executeRecallMemory } from "./tools/recall-memory.js";
import { executeFindFiles } from "./tools/find-files.js";
import { executeCreateMemory } from "./tools/create-memory.js";
import { executeInit, executeStatus, executeListProjects } from "./tools/init-status.js";
import { executeIndexCodebase } from "./tools/index-codebase.js";
import { executeQuery } from "./tools/query.js";
import { executeSmartMemory } from "./tools/smart-memory.js";
import { executeVerifyIndex } from "./tools/verify-index.js";
import { executeManageSitemap } from "./tools/manage-sitemap.js";

// Import schemas
import {
  RecallMemoryInputSchema,
  FindFilesByIntentInputSchema,
  CreateMemoryInputSchema,
  RLMInitInputSchema,
  RLMStatusInputSchema,
  RLMIndexCodebaseInputSchema,
  RLMQueryInputSchema,
  RLMSmartMemoryInputSchema,
  RLMVerifyIndexInputSchema,
  RLMManageSitemapInputSchema
} from "./schemas/index.js";

// Create MCP server instance
const server = new McpServer({
  name: "rlm-memory-mcp-server",
  version: "1.0.0"
});

// Register rlm_init tool
server.registerTool(
  "rlm_init",
  {
    title: "Initialize RLM Project",
    description: `Initialize a new project for RLM memory tracking.

Creates a project folder with memory storage. The project name becomes the folder name.

Args:
  - project_name (string): Name of the project (e.g., "my-awesome-app")
  - working_directory (string): Optional - the actual working directory path for reference

Returns: Project configuration with ID and storage location.

Example: { "project_name": "jumpinotech", "working_directory": "D:\\\\projects\\\\jumpinotech" }`,
    inputSchema: RLMInitInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeInit(params)
);

// Register rlm_status tool
server.registerTool(
  "rlm_status",
  {
    title: "Get RLM Project Status",
    description: `Get the status of an RLM project.

Args:
  - project_name (string): Name of the project
  - response_format ('json' | 'markdown'): Output format (default: 'json')

Returns: Project stats, recent memories, and file map summary.`,
    inputSchema: RLMStatusInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeStatus(params)
);

// Register rlm_list_projects tool
server.registerTool(
  "rlm_list_projects",
  {
    title: "List All RLM Projects",
    description: `List all projects being tracked by RLM.

Returns: Array of project summaries with names, memory counts, and last accessed times.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => executeListProjects()
);

// Register rlm_recall_memory tool
server.registerTool(
  "rlm_recall_memory",
  {
    title: "Recall Project Memory",
    description: `Legacy keyword-based memory search. **Prefer rlm_query**, which searches files + memories + edit history and adds AI analysis.

Use this only when you specifically want raw memory entries for known keywords.

Args:
  - project_name (string): Name of the project
  - keywords (string[]): Keywords extracted from user's prompt (1-20 keywords)
  - limit (number): Max memories to return (default: 10)
  - response_format ('json' | 'markdown'): Output format

Example keywords for "Fix the submit button": ["submit", "button", "form", "ui", "click"]`,
    inputSchema: RecallMemoryInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeRecallMemory(params)
);

// Register rlm_find_files_by_intent tool
server.registerTool(
  "rlm_find_files_by_intent",
  {
    title: "Find Files by Intent",
    description: `Semantic file discovery - replaces grep/find commands.

Describe WHAT you want to do and get relevant file paths.

Args:
  - project_name (string): Name of the project
  - user_prompt (string): Natural language description of what you're looking for
  - limit (number): Max files to return (default: 10)

Examples:
  - "I need to fix the submit button color"
  - "Where is user authentication handled?"
  - "Add a new API endpoint"`,
    inputSchema: FindFilesByIntentInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeFindFiles(params)
);

// Register rlm_create_memory tool
server.registerTool(
  "rlm_create_memory",
  {
    title: "Create Memory",
    description: `Legacy basic memory creation. **Prefer rlm_smart_memory**, which extracts richer metadata (component types, feature areas) and tracks per-file edit history.

Records what was done for future recall and updates the file map.

Args:
  - project_name (string): Name of the project
  - user_prompt (string): Original user request
  - changes_summary (string): Technical summary of changes
  - files_modified (string[]): List of modified file paths
  - keywords (string[]): Optional tags (auto-extracted if not provided)
  - file_descriptions (array): Optional file descriptions for the map

Example:
{
  "project_name": "jumpinotech",
  "user_prompt": "Fix login timeout",
  "changes_summary": "Increased session timeout from 30min to 2hrs",
  "files_modified": ["src/config/auth.ts"],
  "keywords": ["auth", "session", "timeout"]
}`,
    inputSchema: CreateMemoryInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params) => executeCreateMemory(params)
);

// Register rlm_index_codebase tool
server.registerTool(
  "rlm_index_codebase",
  {
    title: "Index Existing Codebase",
    description: `Scan and index an existing codebase to build the file map.

Use this when:
- Starting work on an existing project for the first time
- The AI agent asks to "index", "scan", or "map" the codebase
- You need to understand a large codebase structure

Args:
  - project_name (string): Name of the project
  - directory_path (string): Absolute path to scan (e.g., "D:\\\\projects\\\\my-app")
  - file_patterns (string[]): Optional glob patterns to include (default: common source files)
  - exclude_patterns (string[]): Optional glob patterns to exclude (default: node_modules, dist, etc.)
  - max_files (number): Max files to index (default: 100, max: 500)
  - read_content (boolean): Read file content for better descriptions (slower, default: false)

Example:
{
  "project_name": "my-app",
  "directory_path": "D:\\\\projects\\\\my-app",
  "max_files": 200,
  "read_content": true
}`,
    inputSchema: RLMIndexCodebaseInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params) => executeIndexCodebase(params)
);

// Register rlm_query tool - Key tool for AI agent ↔ MCP communication
server.registerTool(
  "rlm_query",
  {
    title: "Query Project for Relevant Files",
    description: `**PRIMARY TOOL** - Ask the MCP about relevant files for a user's request.

This is the main tool for AI agent ↔ MCP bi-directional communication.
Call this FIRST when starting any task to understand what files are relevant.

Args:
  - project_name (string): Name of the project
  - user_request (string): Description of what the user wants (e.g., "The user wants to change the submit button color")
  - include_memories (boolean): Include relevant past memories (default: true)
  - include_suggestions (boolean): Include AI suggestions for the task (default: true)
  - max_files (number): Max relevant files to return (default: 10)

Returns:
  - relevant_files: List of files with descriptions, recent changes, and why they're relevant
  - relevant_memories: Past work related to this request
  - ai_analysis: Explanation of how to approach the task
  - suggestions: Tips for the AI agent

Example:
{
  "project_name": "my-app",
  "user_request": "The user wants to fix the login form validation"
}`,
    inputSchema: RLMQueryInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeQuery(params)
);

// Register rlm_smart_memory tool - Enhanced memory creation
server.registerTool(
  "rlm_smart_memory",
  {
    title: "Create Smart Memory Entry",
    description: `**MANDATORY - Call this at the END of every task!** Creates a memory entry with rich metadata.

Use this instead of rlm_create_memory for better keyword extraction and file tracking.
Provide detailed change context and the MCP's AI layer will:
- Extract optimal keywords for future semantic search
- Classify files by component type and feature area
- Track edit history for each file
- Update the site map with new features

Args:
  - project_name (string): Name of the project
  - user_prompt (string): Original user request
  - changes_context (string): Detailed description of changes (e.g., "Modified the submit button in LoginForm.tsx to use primary color from theme. Added onClick validation.")
  - files_modified (array): Files changed with details:
    - path (string): File path
    - change_type ("created" | "modified" | "deleted"): Type of change
    - change_summary (string): What changed in this file
  - new_features (array): Optional - new features/components added
  - affected_areas (array): Optional - feature areas affected (e.g., ["auth", "ui"])

Example:
{
  "project_name": "my-app",
  "user_prompt": "Fix the submit button color",
  "changes_context": "Changed the submit button in LoginForm to use the primary theme color instead of hardcoded blue. Also added hover state.",
  "files_modified": [
    {
      "path": "src/components/LoginForm.tsx",
      "change_type": "modified",
      "change_summary": "Updated button color to use theme.primary"
    }
  ],
  "affected_areas": ["auth", "ui"]
}`,
    inputSchema: RLMSmartMemoryInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params) => executeSmartMemory(params)
);

// Register rlm_verify_index tool - Verify what was indexed
server.registerTool(
  "rlm_verify_index",
  {
    title: "Verify Indexed Files",
    description: `Verify what files have been indexed and check for gaps.

Call this AFTER rlm_index_codebase to confirm the indexing is complete.
The MCP will analyze what was indexed and ask: "Is this everything?"

Args:
  - project_name (string): Name of the project to verify
  - expected_features (array): Optional - features you expect to find (e.g., ["auth", "checkout"])
  - report_format ("summary" | "detailed"): Output format (default: "summary")

Returns:
  - files_indexed: Number of files indexed
  - files_by_extension: Breakdown by file type
  - feature_areas: Identified feature areas
  - potential_gaps: Things that might be missing
  - confirmation_prompt: Message for the AI agent to confirm

Example:
{
  "project_name": "my-app",
  "expected_features": ["authentication", "payment", "dashboard"]
}`,
    inputSchema: RLMVerifyIndexInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeVerifyIndex(params)
);

// Register rlm_manage_sitemap tool - Manage sitemap when files change
server.registerTool(
  "rlm_manage_sitemap",
  {
    title: "Manage Sitemap Entries",
    description: `Manage sitemap entries when codebase files are moved, deleted, or updated.

Use this tool when:
- Files are DELETED from the codebase → remove them from sitemap
- Files are MOVED/RENAMED → update their paths in sitemap
- File metadata needs updating → change description, keywords, component_type, or feature_area

Args:
  - project_name (string): Name of the project
  - operations (array): List of operations to perform:
    - action: "delete" | "move" | "update"
    - file_path: Current path in sitemap
    - new_path: New path (required for "move")
    - updates: { description?, keywords?, component_type?, feature_area? } (for "update")

Examples:

Delete files that no longer exist:
{
  "project_name": "my-app",
  "operations": [
    { "action": "delete", "file_path": "src/old-component.tsx" },
    { "action": "delete", "file_path": "src/deprecated/utils.ts" }
  ]
}

Move/rename files:
{
  "project_name": "my-app",
  "operations": [
    { "action": "move", "file_path": "src/Button.tsx", "new_path": "src/components/Button.tsx" }
  ]
}

Update file metadata:
{
  "project_name": "my-app",
  "operations": [
    {
      "action": "update",
      "file_path": "src/auth/login.ts",
      "updates": {
        "description": "Handles user authentication with JWT",
        "feature_area": "auth",
        "component_type": "service"
      }
    }
  ]
}

Mixed operations:
{
  "project_name": "my-app",
  "operations": [
    { "action": "delete", "file_path": "src/legacy.ts" },
    { "action": "move", "file_path": "src/utils.ts", "new_path": "src/lib/utils.ts" },
    { "action": "update", "file_path": "src/api.ts", "updates": { "keywords": ["api", "rest", "http"] } }
  ]
}`,
    inputSchema: RLMManageSitemapInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => executeManageSitemap(params)
);

/**
 * Main entry point - runs the MCP server via stdio
 */
async function main(): Promise<void> {
  // Initialize the LLM provider (OpenRouter or Google Gemini direct)
  const llm = initLLM();
  if (!llm.available) {
    console.error("WARNING: No LLM API key set. AI features will use keyword fallbacks.");
    console.error("Set OPENROUTER_API_KEY (recommended) or GEMINI_API_KEY in .env");
    console.error(`Looked for .env at: ${envPath}`);
  } else {
    console.error(`LLM initialized: ${llm.provider} (model: ${llm.model})`);
  }

  // Run MCP server via stdio (for AI agents)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RLM Memory MCP Server running via stdio");
}

// Handle errors
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
