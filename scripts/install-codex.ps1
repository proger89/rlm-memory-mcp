[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $HOME ".codex\rlm-memory-data"),
  [string]$Model = "gpt-5.5",
  [string]$ProjectCwd = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$distIndex = Join-Path $repoRoot "dist\index.js"

Push-Location $repoRoot
try {
  npm install
  npm run build
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$codexEntrypoint = $null
$entrypointCandidates = @(
  (Join-Path $env:APPDATA "npm\node_modules\@openai\codex\bin\codex.js"),
  "C:\nvm4w\nodejs\node_modules\@openai\codex\bin\codex.js"
)

foreach ($candidate in $entrypointCandidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) {
    $codexEntrypoint = $candidate
    break
  }
}

codex mcp remove rlm-memory *> $null

$args = @(
  "mcp", "add", "rlm-memory",
  "--env", "RLM_DATA_DIR=$DataDir",
  "--env", "LLM_PROVIDER=codex",
  "--env", "CODEX_MODEL=$Model",
  "--env", "CODEX_SANDBOX=read-only",
  "--env", "CODEX_IGNORE_USER_CONFIG=true",
  "--env", "CODEX_IGNORE_RULES=true",
  "--env", "LLM_TIMEOUT_MS=120000",
  "--env", "CODEX_COMMAND=$nodeCommand"
)

if ($codexEntrypoint) {
  $args += @("--env", "CODEX_ENTRYPOINT=$codexEntrypoint")
}

if ($ProjectCwd) {
  $resolvedProject = Resolve-Path -LiteralPath $ProjectCwd
  $args += @("--env", "CODEX_CWD=$($resolvedProject.Path)")
}

$args += @("--", "node", $distIndex)

codex @args
codex mcp get rlm-memory

Write-Host "Installed rlm-memory for Codex CLI. Restart Codex or start a new session to reload MCP tools."
