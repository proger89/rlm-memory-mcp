#!/usr/bin/env node
/**
 * RLM Memory UI Server
 *
 * A web interface to view and manage memories across all RLM projects.
 * Includes comprehensive testing for all MCP tools.
 * Run with: npm start (or npm run dev for development)
 */

import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

// Load .env from the MCP server directory (not CWD)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", "..", ".env");
dotenv.config({ path: envPath });

import express from "express";
import {
  listProjects,
  loadDatabase,
  projectExists,
  clearCache,
  initializeProject,
  deleteMemory,
  deleteFileFromMap
} from "../services/database.js";
import { initLLM, generateContent, getLLMStatus } from "../services/llm.js";
import { UI_PORT, PROJECTS_DIR } from "../constants.js";

// Import tool executors for testing
import { executeRecallMemory } from "../tools/recall-memory.js";
import { executeFindFiles } from "../tools/find-files.js";
import { executeCreateMemory } from "../tools/create-memory.js";
import { executeInit, executeStatus, executeListProjects } from "../tools/init-status.js";
import { executeIndexCodebase } from "../tools/index-codebase.js";
import { executeQuery } from "../tools/query.js";
import { executeSmartMemory } from "../tools/smart-memory.js";
import { executeVerifyIndex } from "../tools/verify-index.js";
import { executeManageSitemap } from "../tools/manage-sitemap.js";

// Zod schemas — the SAME validation the MCP server applies, so the testing
// UI behaves exactly like a real MCP client (defaults, bounds, coercion)
import { z } from "zod";
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
} from "../schemas/index.js";
import type { ToolResult } from "../types.js";

const app = express();
app.use(express.json({ limit: '10mb' }));

// HTML template for the UI
function getHTML(): string {
  const llm = getLLMStatus();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RLM Memory Browser & Testing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.6;
    }
    .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 0;
      border-bottom: 1px solid #30363d;
      margin-bottom: 20px;
    }
    h1 { color: #58a6ff; font-size: 1.8em; }
    .subtitle { color: #8b949e; font-size: 0.9em; margin-top: 5px; }
    h2 { color: #8b949e; font-size: 1.2em; margin-bottom: 15px; }
    h3 { color: #c9d1d9; font-size: 1em; margin-bottom: 10px; }

    .main-tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .main-tab {
      background: #21262d;
      border: 1px solid #30363d;
      color: #8b949e;
      padding: 10px 20px;
      cursor: pointer;
      border-radius: 6px;
      font-size: 1em;
      font-weight: 500;
    }
    .main-tab:hover { background: #30363d; }
    .main-tab.active { background: #238636; color: white; border-color: #238636; }

    .view { display: none; }
    .view.active { display: block; }

    .grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 20px;
      height: calc(100vh - 220px);
    }
    .sidebar {
      background: #161b22;
      border-radius: 8px;
      padding: 15px;
      overflow-y: auto;
    }
    .main {
      background: #161b22;
      border-radius: 8px;
      padding: 20px;
      overflow-y: auto;
    }
    .project-card {
      background: #21262d;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid transparent;
    }
    .project-card:hover { border-color: #30363d; }
    .project-card.active { border-color: #58a6ff; background: #1f2937; }
    .project-name { font-weight: 600; color: #58a6ff; }
    .project-stats { font-size: 0.85em; color: #8b949e; margin-top: 5px; }
    .project-path { font-size: 0.75em; color: #6e7681; margin-top: 3px; word-break: break-all; }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      border-bottom: 1px solid #30363d;
      padding-bottom: 10px;
    }
    .tab {
      background: transparent;
      border: none;
      color: #8b949e;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 6px;
      font-size: 0.9em;
    }
    .tab:hover { background: #21262d; }
    .tab.active { background: #21262d; color: #58a6ff; }
    .memory-card {
      background: #21262d;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      border-left: 3px solid #58a6ff;
    }
    .memory-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .memory-id { font-family: monospace; color: #8b949e; font-size: 0.85em; }
    .memory-date { color: #8b949e; font-size: 0.85em; }
    .memory-prompt { color: #58a6ff; font-weight: 500; margin-bottom: 10px; word-break: break-word; }
    .memory-summary {
      color: #c9d1d9;
      margin-bottom: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
      max-height: 200px;
      overflow-y: auto;
    }
    .memory-files {
      background: #161b22;
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .memory-files code {
      display: block;
      font-family: monospace;
      font-size: 0.85em;
      color: #7ee787;
      padding: 2px 0;
    }
    .keywords {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .keyword {
      background: #30363d;
      color: #8b949e;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.8em;
    }
    .file-card {
      background: #21262d;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .file-path {
      font-family: monospace;
      color: #7ee787;
      font-size: 0.9em;
      margin-bottom: 5px;
    }
    .file-desc { color: #8b949e; font-size: 0.9em; }
    .file-meta { font-size: 0.8em; color: #6e7681; margin-top: 5px; }
    .search-box {
      width: 100%;
      padding: 10px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      margin-bottom: 15px;
    }
    .search-box:focus { outline: none; border-color: #58a6ff; }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #8b949e;
    }
    .stats-row {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
    }
    .stat-box {
      background: #21262d;
      border-radius: 8px;
      padding: 15px 20px;
      flex: 1;
    }
    .stat-value { font-size: 2em; font-weight: 600; color: #58a6ff; }
    .stat-label { color: #8b949e; font-size: 0.9em; }
    .refresh-btn {
      background: #238636;
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9em;
    }
    .refresh-btn:hover { background: #2ea043; }
    .auto-refresh {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #8b949e;
      font-size: 0.85em;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #238636;
      animation: pulse 2s infinite;
    }
    .status-dot.error { background: #f85149; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    /* Testing UI Styles */
    .test-grid {
      display: grid;
      grid-template-columns: 350px 1fr;
      gap: 20px;
      height: calc(100vh - 220px);
    }
    .test-sidebar {
      background: #161b22;
      border-radius: 8px;
      padding: 15px;
      overflow-y: auto;
    }
    .test-main {
      background: #161b22;
      border-radius: 8px;
      padding: 20px;
      overflow-y: auto;
    }
    .tool-card {
      background: #21262d;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: all 0.2s;
      border: 2px solid transparent;
    }
    .tool-card:hover { border-color: #30363d; }
    .tool-card.active { border-color: #58a6ff; background: #1f2937; }
    .tool-card.new { border-left: 3px solid #238636; }
    .tool-name { font-weight: 600; color: #58a6ff; font-family: monospace; }
    .tool-desc { font-size: 0.85em; color: #8b949e; margin-top: 5px; }
    .tool-badge {
      display: inline-block;
      background: #238636;
      color: white;
      font-size: 0.7em;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
    }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      color: #8b949e;
      margin-bottom: 5px;
      font-size: 0.9em;
    }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      padding: 10px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-family: inherit;
    }
    .form-group textarea {
      min-height: 100px;
      resize: vertical;
    }
    .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .run-btn {
      background: #238636;
      border: none;
      color: white;
      padding: 12px 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 1em;
      font-weight: 500;
      width: 100%;
      margin-top: 10px;
    }
    .run-btn:hover { background: #2ea043; }
    .run-btn:disabled { background: #30363d; cursor: not-allowed; }
    .result-box {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 15px;
      margin-top: 20px;
      max-height: 400px;
      overflow-y: auto;
    }
    .result-box pre {
      white-space: pre-wrap;
      word-break: break-word;
      color: #7ee787;
      font-family: monospace;
      font-size: 0.85em;
    }
    .result-box.error pre { color: #f85149; }
    .result-box.success pre { color: #7ee787; }
    .test-status {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
      padding: 10px;
      background: #21262d;
      border-radius: 6px;
    }
    .test-status.pass { border-left: 3px solid #238636; }
    .test-status.fail { border-left: 3px solid #f85149; }
    .gemini-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.8em;
    }
    .gemini-status.available { background: #238636; color: white; }
    .gemini-status.unavailable { background: #f85149; color: white; }

    /* Delete button styles */
    .delete-btn {
      background: transparent;
      border: 1px solid #f85149;
      color: #f85149;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75em;
      transition: all 0.2s;
    }
    .delete-btn:hover {
      background: #f85149;
      color: white;
    }
    .delete-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .confirm-dialog {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .confirm-box {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      text-align: center;
    }
    .confirm-box h3 {
      color: #f85149;
      margin-bottom: 15px;
    }
    .confirm-box p {
      color: #8b949e;
      margin-bottom: 20px;
      font-size: 0.9em;
    }
    .confirm-box code {
      background: #21262d;
      padding: 2px 6px;
      border-radius: 4px;
      color: #7ee787;
      word-break: break-all;
    }
    .confirm-buttons {
      display: flex;
      gap: 10px;
      justify-content: center;
    }
    .confirm-buttons button {
      padding: 10px 20px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 0.9em;
    }
    .confirm-cancel {
      background: #21262d;
      color: #c9d1d9;
    }
    .confirm-cancel:hover { background: #30363d; }
    .confirm-delete {
      background: #f85149;
      color: white;
    }
    .confirm-delete:hover { background: #da3633; }
    .action-row {
      display: flex;
      justify-content: flex-end;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #30363d;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>RLM Memory Browser & Testing</h1>
        <div class="subtitle">
          Projects: ${PROJECTS_DIR.replace(/\\/g, "/")} |
          <span id="geminiStatus" class="gemini-status ${llm.available ? 'available' : 'unavailable'}">
            AI: ${llm.available ? `${llm.provider} · ${llm.model}` : 'Fallback Mode'}
          </span>
        </div>
      </div>
      <div class="header-right">
        <div class="auto-refresh">
          <span class="status-dot"></span>
          <span>Auto-refresh: 5s</span>
        </div>
        <button class="refresh-btn" onclick="loadProjects()">Refresh</button>
      </div>
    </header>

    <div class="main-tabs">
      <button class="main-tab active" onclick="switchMainView('browser')">Memory Browser</button>
      <button class="main-tab" onclick="switchMainView('testing')">Tool Testing</button>
    </div>

    <!-- Browser View -->
    <div id="browserView" class="view active">
      <div class="grid">
        <div class="sidebar">
          <h2>Projects</h2>
          <input type="text" class="search-box" placeholder="Search projects..." id="projectSearch" oninput="filterProjects()">
          <div id="projectList"></div>
        </div>
        <div class="main">
          <div id="projectContent">
            <div class="empty-state">
              <h3>Select a project to view its memories</h3>
              <p>Projects are created when AI agents use rlm_init</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Testing View -->
    <div id="testingView" class="view">
      <div class="test-grid">
        <div class="test-sidebar">
          <h2>Available Tools</h2>
          <div id="toolList"></div>
        </div>
        <div class="test-main">
          <div id="toolForm">
            <div class="empty-state">
              <h3>Select a tool to test</h3>
              <p>All MCP tools can be tested from here</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let projects = [];
    let currentProject = null;
    let currentTab = 'memories';
    let currentTool = null;
    let autoRefreshInterval = null;

    const tools = [
      { name: 'rlm_query', desc: 'Ask MCP about relevant files for a task', new: true, primary: true },
      { name: 'rlm_smart_memory', desc: 'Create memory with rich metadata', new: true },
      { name: 'rlm_verify_index', desc: 'Verify indexing is complete', new: true },
      { name: 'rlm_init', desc: 'Initialize a new project' },
      { name: 'rlm_index_codebase', desc: 'Scan and index existing codebase' },
      { name: 'rlm_recall_memory', desc: 'Retrieve memories by keywords' },
      { name: 'rlm_find_files_by_intent', desc: 'Find files by natural language' },
      { name: 'rlm_create_memory', desc: 'Create a basic memory entry' },
      { name: 'rlm_manage_sitemap', desc: 'Delete/move/update sitemap entries', new: true },
      { name: 'rlm_status', desc: 'Get project status' },
      { name: 'rlm_list_projects', desc: 'List all projects' }
    ];

    function switchMainView(view) {
      document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

      if (view === 'browser') {
        document.querySelector('.main-tab:nth-child(1)').classList.add('active');
        document.getElementById('browserView').classList.add('active');
      } else {
        document.querySelector('.main-tab:nth-child(2)').classList.add('active');
        document.getElementById('testingView').classList.add('active');
        renderToolList();
      }
    }

    function renderToolList() {
      const container = document.getElementById('toolList');
      container.innerHTML = tools.map(t => \`
        <div class="tool-card \${t.new ? 'new' : ''} \${currentTool === t.name ? 'active' : ''}" onclick="selectTool('\${t.name}')">
          <div class="tool-name">
            \${t.name}
            \${t.new ? '<span class="tool-badge">NEW</span>' : ''}
            \${t.primary ? '<span class="tool-badge" style="background:#58a6ff">PRIMARY</span>' : ''}
          </div>
          <div class="tool-desc">\${t.desc}</div>
        </div>
      \`).join('');
    }

    function selectTool(toolName) {
      currentTool = toolName;
      renderToolList();
      renderToolForm(toolName);
    }

    function renderToolForm(toolName) {
      const container = document.getElementById('toolForm');
      const projectOptions = projects.map(p => \`<option value="\${p.name}">\${p.name}</option>\`).join('');

      const forms = {
        'rlm_query': \`
          <h2>rlm_query - Query for Relevant Files</h2>
          <p style="color:#8b949e;margin-bottom:20px">The primary tool for AI agent ↔ MCP communication. Ask what files are relevant for a task.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>User Request (describe what the user wants)</label>
            <textarea id="user_request" placeholder="The user wants to fix the submit button color on the login form">The user wants to fix the submit button</textarea>
          </div>
          <div class="form-group">
            <label>Include Memories</label>
            <select id="include_memories">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          <div class="form-group">
            <label>Include Suggestions</label>
            <select id="include_suggestions">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          <div class="form-group">
            <label>Max Files</label>
            <input type="number" id="max_files" value="10" min="1" max="20">
          </div>
          <button class="run-btn" onclick="runTool('rlm_query')">Run Test</button>
        \`,
        'rlm_smart_memory': \`
          <h2>rlm_smart_memory - Create Smart Memory</h2>
          <p style="color:#8b949e;margin-bottom:20px">Create memory with rich metadata. The AI layer extracts keywords and classifies files.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>User Prompt (original request)</label>
            <input type="text" id="user_prompt" value="Fix the login button color">
          </div>
          <div class="form-group">
            <label>Changes Context (detailed description)</label>
            <textarea id="changes_context" placeholder="Describe what was changed and why">Changed the submit button in LoginForm.tsx to use the primary theme color instead of hardcoded blue. Added hover state styling for better UX.</textarea>
          </div>
          <div class="form-group">
            <label>Files Modified (JSON array)</label>
            <textarea id="files_modified">[{"path": "src/components/LoginForm.tsx", "change_type": "modified", "change_summary": "Updated button color to theme.primary"}]</textarea>
          </div>
          <div class="form-group">
            <label>New Features (comma-separated, optional)</label>
            <input type="text" id="new_features" placeholder="themed-buttons, hover-states">
          </div>
          <div class="form-group">
            <label>Affected Areas (comma-separated, optional)</label>
            <input type="text" id="affected_areas" placeholder="auth, ui">
          </div>
          <button class="run-btn" onclick="runTool('rlm_smart_memory')">Run Test</button>
        \`,
        'rlm_verify_index': \`
          <h2>rlm_verify_index - Verify Indexing</h2>
          <p style="color:#8b949e;margin-bottom:20px">Verify that indexing is complete. Shows what was indexed and potential gaps.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>Expected Features (comma-separated, optional)</label>
            <input type="text" id="expected_features" placeholder="auth, api, components">
          </div>
          <div class="form-group">
            <label>Report Format</label>
            <select id="report_format">
              <option value="summary">Summary</option>
              <option value="detailed">Detailed</option>
            </select>
          </div>
          <button class="run-btn" onclick="runTool('rlm_verify_index')">Run Test</button>
        \`,
        'rlm_init': \`
          <h2>rlm_init - Initialize Project</h2>
          <p style="color:#8b949e;margin-bottom:20px">Create a new project for memory tracking.</p>
          <div class="form-group">
            <label>Project Name</label>
            <input type="text" id="project_name" value="test-project">
          </div>
          <div class="form-group">
            <label>Working Directory (optional)</label>
            <input type="text" id="working_directory" placeholder="D:\\\\projects\\\\my-app">
          </div>
          <button class="run-btn" onclick="runTool('rlm_init')">Run Test</button>
        \`,
        'rlm_index_codebase': \`
          <h2>rlm_index_codebase - Index Codebase</h2>
          <p style="color:#8b949e;margin-bottom:20px">Scan and index an existing codebase to build the file map.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>Directory Path</label>
            <input type="text" id="directory_path" placeholder="D:\\\\projects\\\\my-app">
          </div>
          <div class="form-group">
            <label>Max Files</label>
            <input type="number" id="max_files" value="100" min="1" max="500">
          </div>
          <div class="form-group">
            <label>Read Content (slower but more accurate)</label>
            <select id="read_content">
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>
          <button class="run-btn" onclick="runTool('rlm_index_codebase')">Run Test</button>
        \`,
        'rlm_recall_memory': \`
          <h2>rlm_recall_memory - Recall Memory</h2>
          <p style="color:#8b949e;margin-bottom:20px">Retrieve memories by keywords.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>Keywords (comma-separated)</label>
            <input type="text" id="keywords" value="login, auth, button">
          </div>
          <div class="form-group">
            <label>Limit</label>
            <input type="number" id="limit" value="10" min="1" max="50">
          </div>
          <button class="run-btn" onclick="runTool('rlm_recall_memory')">Run Test</button>
        \`,
        'rlm_find_files_by_intent': \`
          <h2>rlm_find_files_by_intent - Find Files</h2>
          <p style="color:#8b949e;margin-bottom:20px">Find files by natural language intent.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>User Prompt</label>
            <textarea id="user_prompt" placeholder="What are you looking for?">I need to fix the submit button color</textarea>
          </div>
          <div class="form-group">
            <label>Limit</label>
            <input type="number" id="limit" value="10" min="1" max="50">
          </div>
          <button class="run-btn" onclick="runTool('rlm_find_files_by_intent')">Run Test</button>
        \`,
        'rlm_create_memory': \`
          <h2>rlm_create_memory - Create Memory (Legacy)</h2>
          <p style="color:#8b949e;margin-bottom:20px">Create a basic memory entry. Use rlm_smart_memory for better results.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>User Prompt</label>
            <input type="text" id="user_prompt" value="Fix the login button">
          </div>
          <div class="form-group">
            <label>Changes Summary</label>
            <textarea id="changes_summary">Fixed the button color to use theme primary</textarea>
          </div>
          <div class="form-group">
            <label>Files Modified (comma-separated)</label>
            <input type="text" id="files_modified" value="src/components/Button.tsx">
          </div>
          <div class="form-group">
            <label>Keywords (comma-separated, optional)</label>
            <input type="text" id="keywords" placeholder="button, color, fix">
          </div>
          <button class="run-btn" onclick="runTool('rlm_create_memory')">Run Test</button>
        \`,
        'rlm_status': \`
          <h2>rlm_status - Get Project Status</h2>
          <p style="color:#8b949e;margin-bottom:20px">Get statistics for a project.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <button class="run-btn" onclick="runTool('rlm_status')">Run Test</button>
        \`,
        'rlm_list_projects': \`
          <h2>rlm_list_projects - List Projects</h2>
          <p style="color:#8b949e;margin-bottom:20px">List all tracked projects.</p>
          <button class="run-btn" onclick="runTool('rlm_list_projects')">Run Test</button>
        \`,
        'rlm_manage_sitemap': \`
          <h2>rlm_manage_sitemap - Manage Sitemap Entries</h2>
          <p style="color:#8b949e;margin-bottom:20px">Delete, move, or update file entries when the codebase changes.</p>
          <div class="form-group">
            <label>Project Name</label>
            <select id="project_name">\${projectOptions}</select>
          </div>
          <div class="form-group">
            <label>Operations (JSON array)</label>
            <textarea id="operations" rows="8">[
  { "action": "update", "file_path": "src/example.ts", "updates": { "description": "Example file" } }
]</textarea>
          </div>
          <button class="run-btn" onclick="runTool('rlm_manage_sitemap')">Run Test</button>
        \`
      };

      container.innerHTML = (forms[toolName] || '<div class="empty-state">Form not found</div>') + '<div id="testResult"></div>';
    }

    // Parse an integer input; returns undefined for cleared/invalid fields
    // so the server-side zod defaults apply (like an omitted MCP argument).
    function intOrOmit(id) {
      const v = parseInt(document.getElementById(id).value);
      return Number.isNaN(v) ? undefined : v;
    }

    async function runTool(toolName) {
      const resultContainer = document.getElementById('testResult');
      resultContainer.innerHTML = '<div class="result-box"><pre>Running test...</pre></div>';

      let params = {};

      try {
        switch(toolName) {
          case 'rlm_query':
            params = {
              project_name: document.getElementById('project_name').value,
              user_request: document.getElementById('user_request').value,
              include_memories: document.getElementById('include_memories').value === 'true',
              include_suggestions: document.getElementById('include_suggestions').value === 'true',
              max_files: intOrOmit('max_files')
            };
            break;
          case 'rlm_smart_memory':
            params = {
              project_name: document.getElementById('project_name').value,
              user_prompt: document.getElementById('user_prompt').value,
              changes_context: document.getElementById('changes_context').value,
              files_modified: JSON.parse(document.getElementById('files_modified').value),
              new_features: document.getElementById('new_features').value ? document.getElementById('new_features').value.split(',').map(s => s.trim()) : undefined,
              affected_areas: document.getElementById('affected_areas').value ? document.getElementById('affected_areas').value.split(',').map(s => s.trim()) : undefined
            };
            break;
          case 'rlm_verify_index':
            params = {
              project_name: document.getElementById('project_name').value,
              expected_features: document.getElementById('expected_features').value ? document.getElementById('expected_features').value.split(',').map(s => s.trim()) : undefined,
              report_format: document.getElementById('report_format').value
            };
            break;
          case 'rlm_init':
            params = {
              project_name: document.getElementById('project_name').value,
              working_directory: document.getElementById('working_directory').value || undefined
            };
            break;
          case 'rlm_index_codebase':
            params = {
              project_name: document.getElementById('project_name').value,
              directory_path: document.getElementById('directory_path').value,
              max_files: intOrOmit('max_files'),
              read_content: document.getElementById('read_content').value === 'true'
            };
            break;
          case 'rlm_recall_memory':
            params = {
              project_name: document.getElementById('project_name').value,
              keywords: document.getElementById('keywords').value.split(',').map(s => s.trim()),
              limit: intOrOmit('limit')
            };
            break;
          case 'rlm_find_files_by_intent':
            params = {
              project_name: document.getElementById('project_name').value,
              user_prompt: document.getElementById('user_prompt').value,
              limit: intOrOmit('limit')
            };
            break;
          case 'rlm_create_memory':
            params = {
              project_name: document.getElementById('project_name').value,
              user_prompt: document.getElementById('user_prompt').value,
              changes_summary: document.getElementById('changes_summary').value,
              files_modified: document.getElementById('files_modified').value.split(',').map(s => s.trim()),
              keywords: document.getElementById('keywords').value ? document.getElementById('keywords').value.split(',').map(s => s.trim()) : undefined
            };
            break;
          case 'rlm_status':
            params = {
              project_name: document.getElementById('project_name').value
            };
            break;
          case 'rlm_manage_sitemap':
            params = {
              project_name: document.getElementById('project_name').value,
              operations: JSON.parse(document.getElementById('operations').value)
            };
            break;
          case 'rlm_list_projects':
            params = {};
            break;
        }

        const response = await fetch('/api/test/' + toolName, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params)
        });

        const result = await response.json();
        const isSuccess = !result.error && (result.success !== false);

        resultContainer.innerHTML = \`
          <div class="test-status \${isSuccess ? 'pass' : 'fail'}">
            <span>\${isSuccess ? '✅ Test Passed' : '❌ Test Failed'}</span>
          </div>
          <div class="result-box \${isSuccess ? 'success' : 'error'}">
            <pre>\${JSON.stringify(result, null, 2)}</pre>
          </div>
        \`;

        // Refresh projects list after successful test
        if (isSuccess) {
          await loadProjects();
        }
      } catch (error) {
        resultContainer.innerHTML = \`
          <div class="test-status fail">
            <span>❌ Test Failed</span>
          </div>
          <div class="result-box error">
            <pre>\${error.message}</pre>
          </div>
        \`;
      }
    }

    async function loadProjects() {
      try {
        const res = await fetch('/api/projects');
        projects = await res.json();
        renderProjects();

        // If we have a current project, refresh its data too
        if (currentProject) {
          const updated = projects.find(p => p.name === currentProject.config.name);
          if (updated) {
            await selectProject(updated.name);
          }
        }

        // Check LLM provider status
        const statusRes = await fetch('/api/status');
        const status = await statusRes.json();
        const geminiEl = document.getElementById('geminiStatus');
        geminiEl.className = 'gemini-status ' + (status.llm_available ? 'available' : 'unavailable');
        geminiEl.textContent = 'AI: ' + (status.llm_available ? status.llm_provider + ' · ' + status.llm_model : 'Fallback Mode');
      } catch (err) {
        console.error('Failed to load projects:', err);
      }
    }

    function filterProjects() {
      const search = document.getElementById('projectSearch').value.toLowerCase();
      const filtered = projects.filter(p =>
        p.name.toLowerCase().includes(search) ||
        (p.root_path && p.root_path.toLowerCase().includes(search))
      );
      renderProjects(filtered);
    }

    function renderProjects(list = projects) {
      const container = document.getElementById('projectList');
      if (list.length === 0) {
        container.innerHTML = '<div class="empty-state">No projects found</div>';
        return;
      }
      container.innerHTML = list.map(p => \`
        <div class="project-card \${currentProject?.config?.name === p.name ? 'active' : ''}"
             onclick="selectProject('\${p.name.replace(/'/g, "\\\\'")}')">
          <div class="project-name">\${escapeHtml(p.name)}</div>
          <div class="project-stats">\${p.memory_count} memories, \${p.file_count} files</div>
          <div class="project-path">\${escapeHtml(p.root_path || '')}</div>
        </div>
      \`).join('');
    }

    async function selectProject(projectName) {
      try {
        const res = await fetch(\`/api/project?name=\${encodeURIComponent(projectName)}\`);
        currentProject = await res.json();
        renderProjectContent();
        renderProjects();
      } catch (err) {
        console.error('Failed to load project:', err);
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      renderProjectContent();
    }

    function renderProjectContent() {
      if (!currentProject) return;

      const container = document.getElementById('projectContent');
      const memories = currentProject.memory_log || [];
      const files = currentProject.file_map || [];
      const config = currentProject.config || {};

      container.innerHTML = \`
        <div class="stats-row">
          <div class="stat-box">
            <div class="stat-value">\${memories.length}</div>
            <div class="stat-label">Memories</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">\${files.length}</div>
            <div class="stat-label">Files Mapped</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">\${new Date(config.created_at).toLocaleDateString()}</div>
            <div class="stat-label">Created</div>
          </div>
        </div>

        <div class="tabs">
          <button class="tab \${currentTab === 'memories' ? 'active' : ''}" onclick="switchTab('memories')">
            Memories (\${memories.length})
          </button>
          <button class="tab \${currentTab === 'files' ? 'active' : ''}" onclick="switchTab('files')">
            File Map (\${files.length})
          </button>
        </div>

        <div id="tabContent"></div>
      \`;

      const tabContent = document.getElementById('tabContent');

      if (currentTab === 'memories') {
        if (memories.length === 0) {
          tabContent.innerHTML = '<div class="empty-state">No memories yet. AI agents will create them!</div>';
          return;
        }

        const sorted = [...memories].sort((a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        tabContent.innerHTML = sorted.map(m => \`
          <div class="memory-card" id="memory-\${m.id}">
            <div class="memory-header">
              <span class="memory-id">\${escapeHtml(m.id)}</span>
              <span class="memory-date">\${new Date(m.timestamp).toLocaleString()}</span>
            </div>
            <div class="memory-prompt">\${escapeHtml(m.user_prompt)}</div>
            <div class="memory-summary">\${escapeHtml(m.changes_summary)}</div>
            \${m.files_modified.length > 0 ? \`
              <div class="memory-files">
                <strong>Files Modified:</strong>
                \${m.files_modified.map(f => \`<code>\${escapeHtml(f)}</code>\`).join('')}
              </div>
            \` : ''}
            <div class="keywords">
              \${(m.keywords || []).map(k => \`<span class="keyword">\${escapeHtml(k)}</span>\`).join('')}
            </div>
            <div class="action-row">
              <button class="delete-btn" onclick="confirmDeleteMemory('\${m.id}', '\${escapeHtml(m.user_prompt).replace(/'/g, "\\\\'")}')">Delete Memory</button>
            </div>
          </div>
        \`).join('');
      } else {
        if (files.length === 0) {
          tabContent.innerHTML = '<div class="empty-state">No files mapped yet. Use rlm_index_codebase or rlm_smart_memory.</div>';
          return;
        }

        tabContent.innerHTML = files.map((f, index) => \`
          <div class="file-card" id="file-\${index}">
            <div class="file-path">\${escapeHtml(f.path)}</div>
            <div class="file-desc">\${escapeHtml(f.description || '')}</div>
            <div class="file-meta">
              \${f.component_type ? '<span class="keyword">' + escapeHtml(f.component_type) + '</span>' : ''}
              \${f.feature_area ? '<span class="keyword">' + escapeHtml(f.feature_area) + '</span>' : ''}
            </div>
            <div class="keywords" style="margin-top: 8px;">
              \${(f.keywords || []).map(k => \`<span class="keyword">\${escapeHtml(k)}</span>\`).join('')}
            </div>
            \${f.edit_history && f.edit_history.length > 0 ? \`
              <div class="file-meta" style="margin-top:8px;border-top:1px solid #30363d;padding-top:8px">
                <strong>Recent edits:</strong>
                \${f.edit_history.slice(-3).map(e => '<div style="font-size:0.8em;color:#6e7681">' + new Date(e.date).toLocaleDateString() + ': ' + escapeHtml(e.summary || '') + '</div>').join('')}
              </div>
            \` : ''}
            <div class="action-row">
              <button class="delete-btn" onclick="confirmDeleteFile('\${escapeHtml(f.path).replace(/'/g, "\\\\'")}')">Remove from Map</button>
            </div>
          </div>
        \`).join('');
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Confirmation dialog functions
    function showConfirmDialog(title, message, onConfirm) {
      const dialog = document.createElement('div');
      dialog.className = 'confirm-dialog';
      dialog.innerHTML = \`
        <div class="confirm-box">
          <h3>\${title}</h3>
          <p>\${message}</p>
          <div class="confirm-buttons">
            <button class="confirm-cancel" onclick="closeConfirmDialog()">Cancel</button>
            <button class="confirm-delete" id="confirmBtn">Delete</button>
          </div>
        </div>
      \`;
      document.body.appendChild(dialog);
      document.getElementById('confirmBtn').onclick = () => {
        closeConfirmDialog();
        onConfirm();
      };
    }

    function closeConfirmDialog() {
      const dialog = document.querySelector('.confirm-dialog');
      if (dialog) dialog.remove();
    }

    function confirmDeleteMemory(memoryId, prompt) {
      const truncatedPrompt = prompt.length > 50 ? prompt.substring(0, 50) + '...' : prompt;
      showConfirmDialog(
        'Delete Memory?',
        \`Are you sure you want to delete this memory?<br><br><code>\${memoryId}</code><br><br>"\${truncatedPrompt}"\`,
        () => deleteMemoryById(memoryId)
      );
    }

    function confirmDeleteFile(filePath) {
      showConfirmDialog(
        'Remove File from Map?',
        \`Are you sure you want to remove this file from the site map?<br><br><code>\${filePath}</code><br><br>This does NOT delete the actual file, only removes it from RLM tracking.\`,
        () => deleteFileByPath(filePath)
      );
    }

    async function deleteMemoryById(memoryId) {
      if (!currentProject) return;
      try {
        const res = await fetch('/api/memory', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_name: currentProject.config.name,
            memory_id: memoryId
          })
        });
        const result = await res.json();
        if (result.success) {
          // Refresh project data
          await selectProject(currentProject.config.name);
          await loadProjects();
        } else {
          alert('Failed to delete memory: ' + (result.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Failed to delete memory: ' + err.message);
      }
    }

    async function deleteFileByPath(filePath) {
      if (!currentProject) return;
      try {
        const res = await fetch('/api/file', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_name: currentProject.config.name,
            file_path: filePath
          })
        });
        const result = await res.json();
        if (result.success) {
          // Refresh project data
          await selectProject(currentProject.config.name);
          await loadProjects();
        } else {
          alert('Failed to remove file: ' + (result.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Failed to remove file: ' + err.message);
      }
    }

    // Initial load
    loadProjects();

    // Auto-refresh every 5 seconds
    autoRefreshInterval = setInterval(loadProjects, 5000);
  </script>
</body>
</html>`;
}

// Routes
app.get("/", (_req, res) => {
  res.type("html").send(getHTML());
});

app.get("/api/status", (_req, res) => {
  const llm = getLLMStatus();
  res.json({
    llm_available: llm.available,
    llm_provider: llm.provider,
    llm_model: llm.model,
    // legacy field kept for older clients
    gemini_available: llm.available,
    projects_dir: PROJECTS_DIR
  });
});

app.get("/api/projects", async (_req, res) => {
  try {
    clearCache();
    const projects = await listProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/project", async (req, res) => {
  try {
    const projectName = req.query.name as string;
    if (!projectName) {
      return res.status(400).json({ error: "name parameter required" });
    }

    const exists = await projectExists(projectName);
    if (!exists) {
      return res.status(404).json({ error: "Project not found" });
    }

    clearCache(projectName);
    const db = await loadDatabase(projectName);
    res.json(db);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Testing endpoints for all tools — ONE generic dispatcher.
// Inputs are validated with the exact zod schemas the MCP server registers,
// so the testing UI behaves identically to a real MCP client (defaults
// applied, bounds enforced, clear 400s on bad input).
const TOOL_TEST_REGISTRY: Record<string, {
  schema: z.ZodTypeAny | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: any) => Promise<ToolResult>;
}> = {
  rlm_query: { schema: RLMQueryInputSchema, execute: executeQuery },
  rlm_smart_memory: { schema: RLMSmartMemoryInputSchema, execute: executeSmartMemory },
  rlm_verify_index: { schema: RLMVerifyIndexInputSchema, execute: executeVerifyIndex },
  rlm_init: { schema: RLMInitInputSchema, execute: executeInit },
  rlm_index_codebase: { schema: RLMIndexCodebaseInputSchema, execute: executeIndexCodebase },
  rlm_recall_memory: { schema: RecallMemoryInputSchema, execute: executeRecallMemory },
  rlm_find_files_by_intent: { schema: FindFilesByIntentInputSchema, execute: executeFindFiles },
  rlm_create_memory: { schema: CreateMemoryInputSchema, execute: executeCreateMemory },
  rlm_manage_sitemap: { schema: RLMManageSitemapInputSchema, execute: executeManageSitemap },
  rlm_status: { schema: RLMStatusInputSchema, execute: executeStatus },
  rlm_list_projects: { schema: null, execute: () => executeListProjects() }
};

for (const [toolName, def] of Object.entries(TOOL_TEST_REGISTRY)) {
  app.post(`/api/test/${toolName}`, async (req, res) => {
    try {
      let params = req.body;
      if (def.schema) {
        const validation = def.schema.safeParse(req.body);
        if (!validation.success) {
          res.status(400).json({
            success: false,
            error: "Invalid input",
            issues: validation.error.issues.map(
              i => `${i.path.join(".") || "(root)"}: ${i.message}`
            )
          });
          return;
        }
        params = validation.data;
      }

      const result = await def.execute(params);
      const text = result.content[0]?.text ?? "";

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Markdown/plain-text result — wrap it, honoring the error flag
        payload = { result: text, success: !result.isError };
      }

      if (result.isError && payload.success === undefined) {
        payload.success = false;
      }
      res.status(result.isError ? 400 : 200).json(payload);
    } catch (error) {
      res.status(500).json({ error: String(error), success: false });
    }
  });
}

// Delete memory endpoint
app.delete("/api/memory", async (req, res) => {
  try {
    const { project_name, memory_id } = req.body;

    if (!project_name || !memory_id) {
      return res.status(400).json({
        success: false,
        error: "project_name and memory_id are required"
      });
    }

    const exists = await projectExists(project_name);
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: `Project '${project_name}' not found`
      });
    }

    const deleted = await deleteMemory(project_name, memory_id);
    if (deleted) {
      clearCache(project_name);
      res.json({
        success: true,
        message: `Memory '${memory_id}' deleted successfully`
      });
    } else {
      res.status(404).json({
        success: false,
        error: `Memory '${memory_id}' not found in project`
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// Delete file from map endpoint
app.delete("/api/file", async (req, res) => {
  try {
    const { project_name, file_path } = req.body;

    if (!project_name || !file_path) {
      return res.status(400).json({
        success: false,
        error: "project_name and file_path are required"
      });
    }

    const exists = await projectExists(project_name);
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: `Project '${project_name}' not found`
      });
    }

    const deleted = await deleteFileFromMap(project_name, file_path);
    if (deleted) {
      clearCache(project_name);
      res.json({
        success: true,
        message: `File '${file_path}' removed from map successfully`
      });
    } else {
      res.status(404).json({
        success: false,
        error: `File '${file_path}' not found in project file map`
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// LLM connectivity test endpoint (works with any configured provider)
const llmTestHandler = async (_req: express.Request, res: express.Response) => {
  const llm = getLLMStatus();
  try {
    const response = await generateContent("Reply with exactly: LLM connection OK");
    res.json({
      success: true,
      provider: llm.provider,
      model: llm.model,
      response: response,
      message: `${llm.provider} (${llm.model}) is working correctly`
    });
  } catch (error) {
    res.json({
      success: false,
      provider: llm.provider,
      model: llm.model,
      error: String(error),
      message: "LLM API failed - using fallback mode"
    });
  }
};
app.get("/api/test/llm", llmTestHandler);
// Legacy alias
app.get("/api/test/gemini", llmTestHandler);

// Start server
const port = parseInt(process.env.UI_PORT || String(UI_PORT));

// Initialize the LLM provider (OpenRouter or Google Gemini direct)
const llmStatus = initLLM();
if (llmStatus.available) {
  console.log(`✅ LLM initialized: ${llmStatus.provider} (${llmStatus.model})`);
} else {
  console.log("⚠️ No OPENROUTER_API_KEY or GEMINI_API_KEY found - using fallback mode");
}

// Bind to localhost only — this is a local dev UI, not a network service
app.listen(port, "127.0.0.1", () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║               RLM Memory Browser & Testing                     ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║   Open in your browser:                                        ║
║   http://localhost:${port}                                        ║
║                                                                ║
║   Features:                                                    ║
║   - Memory Browser: View all projects and memories             ║
║   - Tool Testing: Test all 11 MCP tools                        ║
║                                                                ║
║   AI Provider: ${llmStatus.available ? `${llmStatus.provider} (${llmStatus.model}) ✅` : 'Fallback Mode ⚠️'}
║                                                                ║
║   Projects directory:                                          ║
║   ${PROJECTS_DIR}
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`);
});
