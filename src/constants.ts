/**
 * Constants for the RLM Memory MCP Server
 */

import * as path from "path";
import { fileURLToPath } from "url";

// Get the directory where this MCP server is installed
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base directory for all project data.
// Defaults to <install dir>/projects; override with RLM_DATA_DIR so data
// can live outside the install tree (survives reinstalls/updates).
export const MCP_ROOT = path.resolve(__dirname, "..");
export const PROJECTS_DIR = process.env.RLM_DATA_DIR
  ? path.resolve(process.env.RLM_DATA_DIR)
  : path.join(MCP_ROOT, "projects");

// LLM provider configuration
// OpenRouter (recommended): one key, any model — https://openrouter.ai
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.5-flash";

// Google Gemini direct — https://aistudio.google.com
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

/** @deprecated kept for backwards compatibility — use GEMINI_DEFAULT_MODEL */
export const GEMINI_MODEL = GEMINI_DEFAULT_MODEL;

// Database folder name (inside each project folder in PROJECTS_DIR)
export const RLM_FOLDER = ".rlm";
export const MEMORY_LOG_FILE = "memory_log.json";
export const FILE_MAP_FILE = "file_map.json";
export const CONFIG_FILE = "config.json";

// Limits
export const CHARACTER_LIMIT = 25000;
export const MAX_MEMORIES_RETURN = 50;
export const MAX_FILES_RETURN = 100;
export const DEFAULT_MEMORY_LIMIT = 10;

// Server configuration
export const DEFAULT_PORT = 3847;
export const UI_PORT = 3848;
