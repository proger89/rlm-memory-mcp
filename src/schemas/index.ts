/**
 * Zod schemas for tool input validation
 */

import { z } from "zod";
import { ResponseFormat } from "../types.js";

/**
 * Schema for recall_memory tool
 */
export const RecallMemoryInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to recall memories from"),
  keywords: z.array(z.string())
    .min(1, "At least one keyword is required")
    .max(20, "Maximum 20 keywords allowed")
    .describe("Keywords to search for in project memory (extracted from user prompt)"),
  limit: z.number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of memories to return (default: 10)"),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.JSON)
    .describe("Output format: 'json' for structured data or 'markdown' for human-readable")
});

export type RecallMemoryInput = z.infer<typeof RecallMemoryInputSchema>;

/**
 * Schema for find_files_by_intent tool
 */
export const FindFilesByIntentInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to search files in"),
  user_prompt: z.string()
    .min(3, "Prompt must be at least 3 characters")
    .max(1000, "Prompt must not exceed 1000 characters")
    .describe("Natural language description of what you're looking for (e.g., 'I need to fix the submit button color')"),
  limit: z.number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of files to return (default: 10)"),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.JSON)
    .describe("Output format: 'json' for structured data or 'markdown' for human-readable")
});

export type FindFilesByIntentInput = z.infer<typeof FindFilesByIntentInputSchema>;

/**
 * Schema for create_memory tool
 */
export const CreateMemoryInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to create memory for"),
  user_prompt: z.string()
    .min(1, "User prompt is required")
    .max(2000, "User prompt must not exceed 2000 characters")
    .describe("The original user request/prompt that led to these changes"),
  changes_summary: z.string()
    .min(1, "Changes summary is required")
    .max(5000, "Changes summary must not exceed 5000 characters")
    .describe("Technical summary of what was changed/implemented"),
  files_modified: z.array(z.string())
    .min(0)
    .max(100)
    .describe("List of file paths that were modified or created"),
  keywords: z.array(z.string())
    .max(20, "Maximum 20 keywords allowed")
    .optional()
    .describe("Optional keywords/tags for this memory. If not provided, they will be auto-extracted."),
  file_descriptions: z.array(z.object({
    path: z.string().describe("File path"),
    description: z.string().describe("Brief description of what this file does")
  }))
    .optional()
    .describe("Optional descriptions for modified files to update the file map")
});

export type CreateMemoryInput = z.infer<typeof CreateMemoryInputSchema>;

/**
 * Schema for rlm_init tool (initialize a new project)
 */
export const RLMInitInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to initialize (e.g., 'my-awesome-app')"),
  working_directory: z.string()
    .optional()
    .describe("Optional - the actual working directory path where the project lives")
});

export type RLMInitInput = z.infer<typeof RLMInitInputSchema>;

/**
 * Schema for rlm_status tool (get project status)
 */
export const RLMStatusInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to get status for"),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.JSON)
    .describe("Output format: 'json' for structured data or 'markdown' for human-readable")
});

export type RLMStatusInput = z.infer<typeof RLMStatusInputSchema>;

/**
 * Schema for rlm_index_codebase tool (scan and index existing codebase)
 */
export const RLMIndexCodebaseInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to index"),
  directory_path: z.string()
    .min(1, "Directory path is required")
    .describe("Absolute path to the directory to scan (e.g., 'D:\\\\projects\\\\my-app')"),
  file_patterns: z.array(z.string())
    .optional()
    .default(["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.py", "**/*.java", "**/*.go", "**/*.rs", "**/*.cpp", "**/*.c", "**/*.h", "**/*.cs", "**/*.rb", "**/*.php", "**/*.vue", "**/*.svelte"])
    .describe("Glob patterns for files to include (default: common source files)"),
  exclude_patterns: z.array(z.string())
    .optional()
    .default([
      "**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**",
      "**/.git/**", "**/vendor/**", "**/__pycache__/**", "**/target/**",
      "**/.next/**", "**/coverage/**", "**/.venv/**", "**/venv/**",
      "**/.idea/**", "**/.vscode/**", "**/.cache/**", "**/*.min.js",
      "**/*.map", "**/*.d.ts"
    ])
    .describe("Glob patterns for files/folders to exclude (full glob syntax supported, e.g. '**/legacy/**' or '**/*.test.ts')"),
  max_files: z.number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Maximum number of files to index (default: 100, max: 500)"),
  read_content: z.boolean()
    .default(false)
    .describe("Whether to read file content for better descriptions (slower but more accurate)")
});

export type RLMIndexCodebaseInput = z.infer<typeof RLMIndexCodebaseInputSchema>;

/**
 * Schema for rlm_query tool (AI agent asks about relevant files for a user request)
 */
export const RLMQueryInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to query"),
  user_request: z.string()
    .min(3, "User request description is required")
    .max(2000, "User request must not exceed 2000 characters")
    .describe("Description of what the user is asking for (e.g., 'The user wants to change the submit button color')"),
  include_memories: z.boolean()
    .default(true)
    .describe("Whether to include relevant past memories in the response"),
  include_suggestions: z.boolean()
    .default(true)
    .describe("Whether to include AI suggestions for the task"),
  max_files: z.number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of relevant files to return")
});

export type RLMQueryInput = z.infer<typeof RLMQueryInputSchema>;

/**
 * Schema for rlm_smart_memory tool (enhanced memory creation with context)
 */
export const RLMSmartMemoryInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project"),
  user_prompt: z.string()
    .min(1, "User prompt is required")
    .max(2000, "User prompt must not exceed 2000 characters")
    .describe("The original user request"),
  changes_context: z.string()
    .min(1, "Changes context is required")
    .max(5000, "Changes context must not exceed 5000 characters")
    .describe("Detailed description of what was changed and why (e.g., 'Modified the submit button in LoginForm.tsx to use primary color from theme. Updated the onClick handler to include form validation.')"),
  files_modified: z.array(z.object({
    path: z.string().describe("File path"),
    change_type: z.enum(["created", "modified", "deleted"]).describe("Type of change"),
    change_summary: z.string().describe("Brief summary of changes to this file")
  }))
    .min(1, "At least one file must be specified")
    .max(50)
    .describe("List of files that were modified with details about each change"),
  new_features: z.array(z.string())
    .optional()
    .describe("List of new features or components added to the codebase"),
  affected_areas: z.array(z.string())
    .optional()
    .describe("Feature areas affected by this change (e.g., 'auth', 'checkout', 'ui')")
});

export type RLMSmartMemoryInput = z.infer<typeof RLMSmartMemoryInputSchema>;

/**
 * Schema for rlm_verify_index tool (verify and confirm what was indexed)
 */
export const RLMVerifyIndexInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project to verify"),
  expected_features: z.array(z.string())
    .optional()
    .describe("Optional list of features/components the AI agent expects to find"),
  report_format: z.enum(["summary", "detailed"])
    .default("summary")
    .describe("Format of the verification report")
});

export type RLMVerifyIndexInput = z.infer<typeof RLMVerifyIndexInputSchema>;

/**
 * Schema for rlm_manage_sitemap tool (manage sitemap entries when files change)
 */
export const RLMManageSitemapInputSchema = z.object({
  project_name: z.string()
    .min(1, "Project name is required")
    .max(100, "Project name must not exceed 100 characters")
    .describe("Name of the project"),
  operations: z.array(z.object({
    action: z.enum(["delete", "move", "update"])
      .describe("Action to perform: 'delete' removes entry, 'move' updates path, 'update' modifies metadata"),
    file_path: z.string()
      .describe("Current file path in the sitemap"),
    new_path: z.string()
      .optional()
      .describe("New file path (required for 'move' action)"),
    updates: z.object({
      description: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      component_type: z.string().optional(),
      feature_area: z.string().optional()
    })
      .optional()
      .describe("Metadata updates (for 'update' action)")
  }))
    .min(1, "At least one operation is required")
    .max(100, "Maximum 100 operations per call")
    .describe("List of operations to perform on sitemap entries")
});

export type RLMManageSitemapInput = z.infer<typeof RLMManageSitemapInputSchema>;
