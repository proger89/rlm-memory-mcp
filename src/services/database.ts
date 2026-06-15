/**
 * Database Service
 * Handles all file-based storage operations for the RLM system
 *
 * All project data is stored centrally in: {PROJECTS_DIR}/{project-name}/.rlm/
 * (PROJECTS_DIR defaults to the install dir, override with RLM_DATA_DIR)
 *
 * Robustness guarantees:
 *  - Atomic writes (temp file + rename) — a crash never corrupts JSON files
 *  - Cache validated against file mtimes — external writes (e.g. the UI
 *    server, which runs as a separate process) are picked up automatically
 *  - Cache keyed by the SANITIZED project name — "My App" and "my-app"
 *    share one cache entry just like they share one on-disk folder
 *  - Per-project write lock (in-process) — read-modify-write sequences
 *    don't trample each other
 */

import * as fs from "fs/promises";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  PROJECTS_DIR,
  RLM_FOLDER,
  MEMORY_LOG_FILE,
  FILE_MAP_FILE,
  CONFIG_FILE
} from "../constants.js";
import type {
  RLMDatabase,
  MemoryEntry,
  FileMapEntry,
  ProjectConfig,
  ProjectSummary
} from "../types.js";

// ---------------------------------------------------------------------------
// Path & name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for storage/comparison:
 * backslashes → forward slashes, strip leading "./"
 */
export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * Find a file entry index by path — exact normalized match first,
 * then case-insensitive (Windows agents often vary path casing).
 */
export function findFileIndex(fileMap: FileMapEntry[], filePath: string): number {
  const target = normalizeFilePath(filePath);
  let index = fileMap.findIndex(f => normalizeFilePath(f.path) === target);
  if (index === -1) {
    const lower = target.toLowerCase();
    index = fileMap.findIndex(f => normalizeFilePath(f.path).toLowerCase() === lower);
  }
  return index;
}

/**
 * Sanitize project name for filesystem and consistency.
 * Names that sanitize to nothing (e.g. emoji/CJK-only) get a stable
 * hash-based name instead of colliding on an empty string.
 */
export function sanitizeProjectName(projectName: string): string {
  const sanitized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (sanitized.length > 0) {
    return sanitized;
  }

  // Deterministic fallback for names with no ASCII characters
  let hash = 0;
  for (let i = 0; i < projectName.length; i++) {
    hash = (hash * 31 + projectName.charCodeAt(i)) >>> 0;
  }
  return `project-${hash.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Locking & atomic IO
// ---------------------------------------------------------------------------

const projectLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively per project (in-process mutex).
 * Use for read-modify-write sequences so concurrent tool calls
 * don't lose each other's updates.
 */
export function withProjectLock<T>(
  projectName: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = sanitizeProjectName(projectName);
  const prev = projectLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  projectLocks.set(key, settled);
  void settled.then(() => {
    if (projectLocks.get(key) === settled) {
      projectLocks.delete(key);
    }
  });
  return run;
}

let tmpCounter = 0;

/**
 * Atomic JSON write: write to a temp file, then rename over the target.
 * A crash mid-write leaves the old file intact instead of a torn JSON file.
 * The temp name is unique per call so concurrent writes to the same file
 * can never interleave inside one temp file.
 */
async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Windows can briefly refuse the rename if a reader has the target open
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      await fs.rename(tmpPath, filePath);
    } catch (retryError) {
      await fs.unlink(tmpPath).catch(() => {});
      throw retryError;
    }
  }
}

// ---------------------------------------------------------------------------
// Cache (mtime-validated)
// ---------------------------------------------------------------------------

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface CacheEntry {
  db: RLMDatabase;
  stamps: { config: FileStamp; memory: FileStamp; fileMap: FileStamp };
}

const databaseCache = new Map<string, CacheEntry>();

async function statStamps(
  rlmPath: string
): Promise<CacheEntry["stamps"]> {
  const [c, m, f] = await Promise.all([
    fs.stat(path.join(rlmPath, CONFIG_FILE)),
    fs.stat(path.join(rlmPath, MEMORY_LOG_FILE)),
    fs.stat(path.join(rlmPath, FILE_MAP_FILE))
  ]);
  return {
    config: { mtimeMs: c.mtimeMs, size: c.size },
    memory: { mtimeMs: m.mtimeMs, size: m.size },
    fileMap: { mtimeMs: f.mtimeMs, size: f.size }
  };
}

function stampsEqual(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Invalidate the cache for a project after any write so the next read
 * re-loads fresh state from disk.
 */
function invalidateCache(projectName: string): void {
  databaseCache.delete(sanitizeProjectName(projectName));
}

/**
 * Ensure the projects directory exists
 */
async function ensureProjectsDir(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

/**
 * Get the project folder path (inside PROJECTS_DIR)
 */
export function getProjectPath(projectName: string): string {
  const safeName = sanitizeProjectName(projectName);
  return path.join(PROJECTS_DIR, safeName);
}

/**
 * Get the .rlm folder path for a project
 */
export function getRLMPath(projectName: string): string {
  return path.join(getProjectPath(projectName), RLM_FOLDER);
}

/**
 * Check if a project exists
 */
export async function projectExists(projectName: string): Promise<boolean> {
  try {
    const rlmPath = getRLMPath(projectName);
    await fs.access(rlmPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a new project
 */
export async function initializeProject(
  projectName: string,
  originalPath?: string
): Promise<ProjectConfig> {
  await ensureProjectsDir();

  // Always use sanitized name for consistency
  const safeName = sanitizeProjectName(projectName);
  const rlmPath = getRLMPath(projectName);

  // Create project and .rlm folders
  await fs.mkdir(rlmPath, { recursive: true });

  const projectId = uuidv4();
  const now = new Date().toISOString();

  const config: ProjectConfig = {
    project_id: projectId,
    name: safeName, // Use sanitized name for consistency
    root_path: originalPath || getProjectPath(projectName), // Store original working directory if provided
    created_at: now,
    last_accessed: now
  };

  // Initialize files atomically
  await Promise.all([
    atomicWriteJSON(path.join(rlmPath, CONFIG_FILE), config),
    atomicWriteJSON(path.join(rlmPath, MEMORY_LOG_FILE), []),
    atomicWriteJSON(path.join(rlmPath, FILE_MAP_FILE), [])
  ]);

  invalidateCache(projectName);
  return config;
}

/**
 * Load the full database for a project.
 * Cached per project; the cache is validated against file mtime+size so
 * writes from other processes (e.g. the web UI) are picked up automatically.
 *
 * Pass fresh=true (used by all locked read-modify-write paths) to bypass
 * the cache entirely — write paths must never trust a same-granule-stale
 * cache, or external deletes could be silently resurrected.
 */
export async function loadDatabase(
  projectName: string,
  fresh = false
): Promise<RLMDatabase> {
  const cacheKey = sanitizeProjectName(projectName);
  const rlmPath = getRLMPath(projectName);

  let stamps: CacheEntry["stamps"] | null = null;
  try {
    stamps = await statStamps(rlmPath);
  } catch {
    // Files missing — fall through to the read below for a proper error
  }

  const cached = databaseCache.get(cacheKey);
  if (
    !fresh &&
    cached &&
    stamps &&
    stampsEqual(cached.stamps.config, stamps.config) &&
    stampsEqual(cached.stamps.memory, stamps.memory) &&
    stampsEqual(cached.stamps.fileMap, stamps.fileMap)
  ) {
    return cached.db;
  }

  try {
    const [configData, memoryData, fileMapData] = await Promise.all([
      fs.readFile(path.join(rlmPath, CONFIG_FILE), "utf-8"),
      fs.readFile(path.join(rlmPath, MEMORY_LOG_FILE), "utf-8"),
      fs.readFile(path.join(rlmPath, FILE_MAP_FILE), "utf-8")
    ]);

    const config = JSON.parse(configData) as ProjectConfig;
    const memoryLog = JSON.parse(memoryData) as MemoryEntry[];
    const fileMap = JSON.parse(fileMapData) as FileMapEntry[];

    // Defensive shape validation — a hand-edited or corrupt file should
    // produce a clear error, not cryptic crashes in every tool.
    if (!Array.isArray(memoryLog)) {
      throw new Error(`${MEMORY_LOG_FILE} is not a JSON array`);
    }
    if (!Array.isArray(fileMap)) {
      throw new Error(`${FILE_MAP_FILE} is not a JSON array`);
    }

    const database: RLMDatabase = {
      config,
      memory_log: memoryLog,
      file_map: fileMap
    };

    if (stamps) {
      databaseCache.set(cacheKey, { db: database, stamps });
    }

    return database;
  } catch (error) {
    throw new Error(
      `Failed to load RLM database for project '${projectName}': ${error}`
    );
  }
}

/**
 * Save memory log to disk (atomic)
 */
export async function saveMemoryLog(
  projectName: string,
  memoryLog: MemoryEntry[]
): Promise<void> {
  const rlmPath = getRLMPath(projectName);
  await atomicWriteJSON(path.join(rlmPath, MEMORY_LOG_FILE), memoryLog);
  invalidateCache(projectName);
}

/**
 * Save file map to disk (atomic)
 */
export async function saveFileMap(
  projectName: string,
  fileMap: FileMapEntry[]
): Promise<void> {
  const rlmPath = getRLMPath(projectName);
  await atomicWriteJSON(path.join(rlmPath, FILE_MAP_FILE), fileMap);
  invalidateCache(projectName);
}

/**
 * Update last accessed timestamp
 */
export async function updateLastAccessed(projectName: string): Promise<void> {
  const rlmPath = getRLMPath(projectName);
  const configPath = path.join(rlmPath, CONFIG_FILE);

  try {
    const configData = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configData) as ProjectConfig;
    config.last_accessed = new Date().toISOString();
    await atomicWriteJSON(configPath, config);
    invalidateCache(projectName);
  } catch {
    // Ignore errors for timestamp update
  }
}

/**
 * Add a new memory entry (locked read-modify-write)
 */
export async function addMemory(
  projectName: string,
  entry: Omit<MemoryEntry, "id" | "timestamp">
): Promise<MemoryEntry> {
  return withProjectLock(projectName, async () => {
    const database = await loadDatabase(projectName, true);

    const memory: MemoryEntry = {
      ...entry,
      id: `mem_${uuidv4().slice(0, 8)}`,
      timestamp: new Date().toISOString()
    };

    const updatedLog = [...database.memory_log, memory];
    await saveMemoryLog(projectName, updatedLog);

    return memory;
  });
}

/**
 * Search memories by keywords
 */
export async function searchMemories(
  projectName: string,
  keywords: string[],
  limit: number = 10
): Promise<MemoryEntry[]> {
  const database = await loadDatabase(projectName);
  const normalizedKeywords = keywords.map(k => k.toLowerCase());

  // Score each memory by keyword matches
  const scored = database.memory_log.map(memory => {
    const memoryText = [
      ...(memory.keywords || []),
      memory.user_prompt || "",
      memory.changes_summary || "",
      memory.full_context || "",
      ...(memory.files_modified || [])
    ].join(" ").toLowerCase();

    const score = normalizedKeywords.reduce((acc, keyword) => {
      return acc + (memoryText.includes(keyword) ? 1 : 0);
    }, 0);

    return { memory, score };
  });

  // Sort by score (descending) and then by timestamp (descending)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.memory.timestamp).getTime() - new Date(a.memory.timestamp).getTime();
  });

  // Return top matches with score > 0
  return scored
    .filter(s => s.score > 0)
    .slice(0, limit)
    .map(s => s.memory);
}

/**
 * Input shape for file map updates
 */
export interface FileMapUpdate {
  path: string;
  /** Empty/undefined description preserves the existing one */
  description?: string;
  keywords?: string[];
  component_type?: string;
  feature_area?: string;
  /** When provided, appended to the entry's edit history */
  edit_summary?: string;
  memory_id?: string;
}

/**
 * Update or add file map entries (locked read-modify-write).
 *
 * MERGE semantics — existing metadata is preserved unless explicitly
 * replaced: empty descriptions don't clobber good ones, keywords are
 * unioned, component_type/feature_area survive partial updates, and
 * edit history accumulates.
 */
export async function updateFileMap(
  projectName: string,
  files: FileMapUpdate[]
): Promise<string[]> {
  return withProjectLock(projectName, async () => {
    const database = await loadDatabase(projectName, true);
    const fileMap = [...database.file_map];
    const updatedPaths: string[] = [];
    const now = new Date().toISOString();

    for (const file of files) {
      const normalizedPath = normalizeFilePath(file.path);
      const existingIndex = findFileIndex(fileMap, normalizedPath);

      const editEntry = file.edit_summary
        ? { date: now, summary: file.edit_summary, memory_id: file.memory_id }
        : null;

      if (existingIndex >= 0) {
        const existing = fileMap[existingIndex];
        const editHistory = [...(existing.edit_history || [])];
        if (editEntry) {
          editHistory.push(editEntry);
        }

        fileMap[existingIndex] = {
          path: normalizedPath,
          description: file.description?.trim() ? file.description : existing.description,
          keywords: [...new Set([...(existing.keywords || []), ...(file.keywords || [])])].slice(0, 10),
          last_modified: now,
          component_type: file.component_type ?? existing.component_type,
          feature_area: file.feature_area ?? existing.feature_area,
          edit_history: editHistory.slice(-10) // Keep last 10 edits
        };
      } else {
        fileMap.push({
          path: normalizedPath,
          description: file.description || "",
          keywords: file.keywords || [],
          last_modified: now,
          component_type: file.component_type,
          feature_area: file.feature_area,
          edit_history: editEntry ? [editEntry] : undefined
        });
      }

      updatedPaths.push(normalizedPath);
    }

    await saveFileMap(projectName, fileMap);
    return updatedPaths;
  });
}

/**
 * Get all file map entries
 */
export async function getFileMap(projectName: string): Promise<FileMapEntry[]> {
  const database = await loadDatabase(projectName);
  return database.file_map;
}

/**
 * List all projects in the projects directory
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureProjectsDir();

  const projects: ProjectSummary[] = [];

  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectName = entry.name;
        if (await projectExists(projectName)) {
          try {
            const db = await loadDatabase(projectName);
            projects.push({
              project_id: db.config.project_id,
              name: db.config.name,
              root_path: db.config.root_path,
              memory_count: db.memory_log.length,
              file_count: db.file_map.length,
              last_accessed: db.config.last_accessed
            });
          } catch {
            // Skip projects that can't be loaded
          }
        }
      }
    }
  } catch {
    // Projects dir might not exist yet
  }

  // Sort by last accessed
  projects.sort((a, b) =>
    new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime()
  );

  return projects;
}

/**
 * Clear cache for a project
 */
export function clearCache(projectName?: string): void {
  if (projectName) {
    invalidateCache(projectName);
  } else {
    databaseCache.clear();
  }
}

/**
 * Delete a memory entry by ID (locked read-modify-write)
 */
export async function deleteMemory(
  projectName: string,
  memoryId: string
): Promise<boolean> {
  return withProjectLock(projectName, async () => {
    const database = await loadDatabase(projectName, true);
    const index = database.memory_log.findIndex(m => m.id === memoryId);

    if (index === -1) {
      return false;
    }

    const updatedLog = database.memory_log.filter(m => m.id !== memoryId);
    await saveMemoryLog(projectName, updatedLog);
    return true;
  });
}

/**
 * Delete a file from the file map by path (locked read-modify-write)
 */
export async function deleteFileFromMap(
  projectName: string,
  filePath: string
): Promise<boolean> {
  return withProjectLock(projectName, async () => {
    const database = await loadDatabase(projectName, true);
    const index = findFileIndex(database.file_map, filePath);

    if (index === -1) {
      return false;
    }

    const updatedMap = database.file_map.filter((_, i) => i !== index);
    await saveFileMap(projectName, updatedMap);
    return true;
  });
}

// Legacy compatibility - these functions now work with project names
export const isProjectInitialized = projectExists;
