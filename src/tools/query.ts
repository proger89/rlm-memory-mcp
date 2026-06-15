/**
 * rlm_query tool implementation
 *
 * This is the key tool for bi-directional AI agent ↔ MCP communication.
 * The AI agent asks: "The user wants X, what files should I look at?"
 * The MCP's AI layer searches memory + file map + edit history to provide a smart answer.
 */

import { type RLMQueryInput } from "../schemas/index.js";
import {
  loadDatabase,
  projectExists,
  updateLastAccessed,
  normalizeFilePath
} from "../services/database.js";
import { generateJSON, scoreFiles, isLLMAvailable } from "../services/llm.js";
import type { QueryResult, FileMapEntry, MemoryEntry } from "../types.js";

/** Cap how many files are serialized into the prompt (keeps cost bounded) */
const MAX_PROMPT_FILES = 150;

interface QueryAnalysis {
  relevantFiles: string[];
  analysis: string;
  suggestions: string[];
  usedFallback: boolean;
}

/**
 * Ranked keyword fallback (shared scorer with stop words, path boosts,
 * type/area weighting and edit-history recency).
 */
function keywordFallback(userRequest: string, fileMap: FileMapEntry[]): QueryAnalysis {
  const ranked = scoreFiles(
    userRequest,
    fileMap.map(f => ({
      path: f.path,
      description: f.description || "",
      keywords: f.keywords || [],
      component_type: f.component_type,
      feature_area: f.feature_area,
      edit_history: f.edit_history
    }))
  );

  return {
    relevantFiles: ranked.filter(s => s.score > 0).slice(0, 10).map(s => s.file.path),
    analysis: "Matched using ranked keyword search (AI analysis unavailable). Files are ordered by keyword, path, type/area and edit-history relevance.",
    suggestions: ["Consider indexing the codebase with read_content=true for better analysis"],
    usedFallback: true
  };
}

/**
 * Analyze the user request and find relevant files using the LLM
 */
async function analyzeRequestWithAI(
  userRequest: string,
  fileMap: FileMapEntry[],
  memories: MemoryEntry[]
): Promise<QueryAnalysis> {
  if (!isLLMAvailable()) {
    return keywordFallback(userRequest, fileMap);
  }

  // Pre-filter very large maps so the prompt stays bounded — keyword-ranked
  // candidates first, then most recent files to fill up.
  let candidates = fileMap;
  if (fileMap.length > MAX_PROMPT_FILES) {
    const ranked = scoreFiles(
      userRequest,
      fileMap.map(f => ({
        path: f.path,
        description: f.description || "",
        keywords: f.keywords || [],
        component_type: f.component_type,
        feature_area: f.feature_area,
        edit_history: f.edit_history
      }))
    );
    const topPaths = new Set(
      ranked.filter(s => s.score > 0).slice(0, MAX_PROMPT_FILES).map(s => s.file.path)
    );
    candidates = fileMap.filter(f => topPaths.has(f.path));
    if (candidates.length < MAX_PROMPT_FILES) {
      for (const f of fileMap) {
        if (candidates.length >= MAX_PROMPT_FILES) break;
        if (!topPaths.has(f.path)) candidates.push(f);
      }
    }
  }

  // Build context for the LLM
  const fileContext = candidates.map(f => {
    const editHistory = f.edit_history?.slice(-3).map(e => `  - ${e.date}: ${e.summary}`).join("\n") || "";
    const keywords = f.keywords || [];
    return `- ${f.path}
  Description: ${f.description || "No description"}
  Keywords: ${keywords.join(", ") || "none"}
  Component Type: ${f.component_type || "unknown"}
  Feature Area: ${f.feature_area || "unknown"}
  Last Modified: ${f.last_modified || "unknown"}
  ${editHistory ? `Recent Changes:\n${editHistory}` : ""}`;
  }).join("\n\n");

  // Most RECENT memories (the log is append-ordered, so take the tail)
  const recentMemories = memories.slice(-10).reverse();
  const memoryContext = recentMemories.map(m =>
    `- [${m.id}] ${m.user_prompt}\n  Changes: ${m.changes_summary}\n  Files: ${m.files_modified.join(", ")}`
  ).join("\n\n");

  const prompt = `You are an AI assistant helping another AI agent find relevant files for a coding task.
The user's request has been analyzed, and you need to identify which files in the codebase are relevant.

USER REQUEST: "${userRequest}"

AVAILABLE FILES IN CODEBASE:
${fileContext || "No files indexed yet."}

RECENT PROJECT HISTORY (newest first):
${memoryContext || "No previous work history."}

Based on the user request, analyze:
1. Which files are DIRECTLY relevant to this task (must work on)
2. Which files are INDIRECTLY relevant (might need to reference)
3. What the AI agent should know before starting

IMPORTANT RULES:
- Be SPECIFIC: If the user wants to change ONE button, don't return ALL button components
- Look at the component_type and feature_area to narrow down
- Consider the edit history - if a file was recently modified for similar work, it's more relevant
- Look at memory history - if similar work was done before, those files are likely relevant
- Only return file paths that appear in the list above - never invent paths

Return ONLY a JSON object with this exact structure:
{
  "relevant_files": ["path1", "path2"],
  "analysis": "Brief explanation of why these files are relevant and how they relate to the request",
  "suggestions": ["Suggestion 1 for the AI agent", "Suggestion 2"]
}`;

  try {
    const parsed = await generateJSON<Record<string, unknown>>(prompt, {
      schema: {
        type: "object",
        properties: {
          relevant_files: { type: "array", items: { type: "string" } },
          analysis: { type: "string" },
          suggestions: { type: "array", items: { type: "string" } }
        },
        required: ["relevant_files", "analysis", "suggestions"],
        additionalProperties: false
      },
      schemaName: "query_analysis"
    });

    if (parsed) {
      // Accept both snake_case (requested) and camelCase (some models drift)
      const rawFiles = parsed.relevant_files ?? parsed.relevantFiles;
      const files = Array.isArray(rawFiles)
        ? rawFiles.filter((p): p is string => typeof p === "string")
        : [];
      const analysis = typeof parsed.analysis === "string" ? parsed.analysis : "";
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === "string")
        : [];

      if (files.length > 0 || analysis) {
        return { relevantFiles: files, analysis, suggestions, usedFallback: false };
      }
    }
  } catch {
    // Fall through to keyword matching
  }

  return keywordFallback(userRequest, fileMap);
}

/**
 * Find relevant memories based on the user request
 */
function findRelevantMemories(
  userRequest: string,
  memories: MemoryEntry[],
  limit: number = 5
): MemoryEntry[] {
  const requestWords = userRequest.toLowerCase().split(/\W+/).filter(w => w.length > 2);

  // Score memories by relevance
  const scored = memories.map(memory => {
    const memoryText = [
      memory.user_prompt || "",
      memory.changes_summary || "",
      ...(memory.keywords || []),
      ...(memory.files_modified || [])
    ].join(" ").toLowerCase();

    const score = requestWords.reduce((acc, word) => {
      return acc + (memoryText.includes(word) ? 1 : 0);
    }, 0);

    return { memory, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.memory);
}

/**
 * Execute the rlm_query tool
 */
export async function executeQuery(
  params: RLMQueryInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
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
      }]
    };
  }

  await updateLastAccessed(projectName);

  // Load database
  const database = await loadDatabase(projectName);
  const fileMap = database.file_map;
  const memories = database.memory_log;

  if (fileMap.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          message: "No files indexed in this project yet.",
          suggestion: "Use rlm_index_codebase to scan the codebase first, or add files via rlm_smart_memory after making changes.",
          relevant_files: [],
          relevant_memories: [],
          success: true
        }, null, 2)
      }]
    };
  }

  // Analyze with AI
  const aiAnalysis = await analyzeRequestWithAI(
    params.user_request,
    fileMap,
    memories
  );

  // Get detailed file info for relevant files.
  // Match by normalized path so separator/case drift in LLM output
  // doesn't silently drop results.
  const relevantFilePaths = aiAnalysis.relevantFiles || [];
  const byNormalizedPath = new Map(
    fileMap.map(f => [normalizeFilePath(f.path).toLowerCase(), f])
  );
  const relevantFileDetails = relevantFilePaths
    .map(p => byNormalizedPath.get(normalizeFilePath(p).toLowerCase()))
    .filter((f): f is FileMapEntry => f !== undefined)
    .slice(0, params.max_files)
    .map(f => {
      return {
        path: f.path,
        description: f.description || "No description",
        relevance_reason: aiAnalysis.usedFallback
          ? "Matched by ranked keyword search"
          : "Selected by AI analysis of the request",
        last_modified: f.last_modified || "unknown",
        recent_changes: f.edit_history?.slice(-3).map(e => e.summary),
        component_type: f.component_type,
        feature_area: f.feature_area
      };
    });

  // Get relevant memories if requested
  let relevantMemoryDetails: Array<{
    id: string;
    summary: string;
    date: string;
    files: string[];
  }> = [];

  if (params.include_memories) {
    const relevantMemories = findRelevantMemories(params.user_request, memories);
    relevantMemoryDetails = relevantMemories.map(m => ({
      id: m.id,
      summary: m.changes_summary,
      date: m.timestamp,
      files: m.files_modified
    }));
  }

  const result: QueryResult = {
    relevant_files: relevantFileDetails,
    relevant_memories: relevantMemoryDetails,
    ai_analysis: aiAnalysis.analysis || "Analysis not available",
    suggestions: params.include_suggestions ? (aiAnalysis.suggestions || []) : undefined
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        user_request: params.user_request,
        ai_powered: !aiAnalysis.usedFallback,
        ...result,
        _instructions: "These are the files relevant to the user's request. Start with the files at the top of the list. Check the recent_changes to understand what was done before."
      }, null, 2)
    }]
  };
}
