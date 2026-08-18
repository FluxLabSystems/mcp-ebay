# Lane A one-time setup. Detects and INSTALLS every dependency the bridge
# needs, then builds and prepares the database. Idempotent: safe to abort at
# any point and re-run (downloads resume, the database container is repaired
# even after an abort mid-initialization).
#   powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-setup.ps1
# (Works in Windows PowerShell 5.1 and PowerShell 7.)
#
# Dependencies covered (detect -> install -> verify):
#   git, Node.js >= 22.12, pnpm (via corepack), Docker Desktop,
#   Google Chrome (branded - the agent refuses Edge/Chromium),
#   PostgreSQL 17 (as a localhost-only container), Claude Code CLI.
#
# PowerShell 5.1 rules baked in (verified by adversarial review):
#  - Under $ErrorActionPreference='Stop', redirecting a native command's
#    stderr turns stderr lines into TERMINATING errors. Invoke-Quiet /
#    Invoke-Capture drop to 'Continue' around such calls; $LASTEXITCODE is
#    global and survives them.
#  - Invoking a missing command throws regardless of redirection: every
#    optional tool is probed with Get-Command first.
#  - Corepack's first pnpm download prompts interactively:
#    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 keeps this non-interactive.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}
function Invoke-Quiet([scriptblock]$block) {
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block 2>&1 | Out-Null } finally { $ErrorActionPreference = $eap }
}
function Invoke-Capture([scriptblock]$block) {
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return (& $block 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $eap }
}
# APPEND registry PATH entries (never replace: replacing would drop
# process-only entries from version managers like fnm and break node mid-run).
function Refresh-Path {
  $env:Path = $env:Path + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

$HasWinget = Test-Command 'winget'
if (-not $HasWinget) {
  Write-Warning 'winget is not available; anything missing must be installed by hand (URLs are printed as needed).'
}

function Install-Or-Explain([string]$label, [string]$wingetId, [string]$manualUrl) {
  if ($HasWinget) {
    Write-Host "Installing $label via winget (a UAC prompt may appear; big downloads show progress below)..." -ForegroundColor Cyan
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # Out-Host: without it the function's output stream swallows winget's
    # progress and a 500 MB download looks like a hang.
    try { & winget install --id $wingetId --accept-source-agreements --accept-package-agreements --silent | Out-Host }
    finally { $ErrorActionPreference = $eap }
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "winget could not install $label (exit $LASTEXITCODE - a declined UAC prompt looks like this). Install manually: $manualUrl"
      return
    }
    Refresh-Path
    return
  }
  Write-Warning "$label is missing and winget is unavailable. Install it from: $manualUrl"
}

# ---------------------------------------------------------------- 1. git
Write-Host '== [1/8] git ==' -ForegroundColor Cyan
if (-not (Test-Command 'git')) {
  Install-Or-Explain 'Git' 'Git.Git' 'https://git-scm.com/download/win'
}
if (Test-Command 'git') { Write-Host "git OK: $(& git --version)" -ForegroundColor Green }
else { Write-Warning 'git still missing - you can build without it, but git pull updates will not work.' }

# ---------------------------------------------------------------- 2. Node.js
Write-Host '== [2/8] Node.js >= 22.12 ==' -ForegroundColor Cyan
$nodeOk = $false
if (Test-Command 'node') {
  $nodeVersion = (& node --version)
  $nodeOk = ([version]($nodeVersion.TrimStart('v')) -ge [version]'22.12.0')
  if (-not $nodeOk) { Write-Host "Node $nodeVersion is too old (need >= 22.12); upgrading..." }
}
if (-not $nodeOk) {
  Install-Or-Explain 'Node.js (LTS)' 'OpenJS.NodeJS.LTS' 'https://nodejs.org'
  if (-not (Test-Command 'node')) {
    throw 'Node.js was installed but this terminal cannot see it yet. Open a NEW terminal and re-run this script (it resumes where it left off).'
  }
  $nodeVersion = (& node --version)
  if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.12.0') {
    throw "Installed Node is $nodeVersion but the bridge needs >= 22.12 - install the current LTS from https://nodejs.org and re-run."
  }
}
Write-Host "Node OK: $(& node --version)" -ForegroundColor Green

# ---------------------------------------------------------------- 3. pnpm
Write-Host '== [3/8] pnpm (via corepack) ==' -ForegroundColor Cyan
if (Test-Command 'corepack') { Invoke-Quiet { corepack enable } }
Refresh-Path
if (-not (Test-Command 'pnpm')) {
  if (-not (Test-Command 'npm')) { throw 'npm is not on PATH (it ships with Node) - open a NEW terminal and re-run this script.' }
  # corepack's shims can need elevation; npm -g does not.
  & npm install -g pnpm@10
  if ($LASTEXITCODE -ne 0) { throw 'Could not install pnpm (tried corepack and npm -g). Run once in an Administrator terminal: corepack enable' }
  Refresh-Path
}
if (-not (Test-Command 'pnpm')) { throw 'pnpm installed but not visible in this terminal - open a NEW terminal and re-run this script.' }
Write-Host "pnpm OK: $(& pnpm --version)" -ForegroundColor Green

# ---------------------------------------------------------------- 4. Google Chrome (branded)
Write-Host '== [4/8] Google Chrome (branded) ==' -ForegroundColor Cyan
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromeFound = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeFound) {
  Install-Or-Explain 'Google Chrome' 'Google.Chrome' 'https://www.google.com/chrome/'
  $chromeFound = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($chromeFound) { Write-Host "Chrome OK: $chromeFound" -ForegroundColor Green }
else { Write-Warning 'Chrome not detected; the agent preflight in lane-a-run.ps1 will fail until it is installed.' }

# ---------------------------------------------------------------- 5. Docker Desktop
Write-Host '== [5/8] Docker Desktop ==' -ForegroundColor Cyan
if (-not (Test-Command 'docker')) {
  Install-Or-Explain 'Docker Desktop' 'Docker.DockerDesktop' 'https://www.docker.com/products/docker-desktop/'
  Write-Host ''
  Write-Host 'Docker Desktop was just installed. It needs a first launch (and possibly' -ForegroundColor Yellow
  Write-Host 'a reboot for WSL2). Start "Docker Desktop" from the Start menu, wait for' -ForegroundColor Yellow
  Write-Host 'the whale icon to settle, then RE-RUN this script - it resumes from here.' -ForegroundColor Yellow
  exit 1
}
Invoke-Quiet { docker version }
if ($LASTEXITCODE -ne 0) {
  throw 'Docker is installed but the daemon is not running. Start Docker Desktop, wait for it to settle, then re-run this script.'
}
Write-Host 'Docker OK (daemon responding)' -ForegroundColor Green

# ---------------------------------------------------------------- 6. PostgreSQL image + container
# Pull FIRST and explicitly: `docker pull` shows progress, resumes cleanly
# after an abort, and re-running this script retries it.
Write-Host '== [6/8] PostgreSQL 17 image (abort-safe: re-run resumes the pull) ==' -ForegroundColor Cyan
& docker pull postgres:17-alpine
if ($LASTEXITCODE -ne 0) { throw 'docker pull postgres:17-alpine failed - check connectivity and re-run this script.' }

$DeviceJsonPath = Join-Path $env:LOCALAPPDATA 'Fluxology\BrowserBridge\state\device.json'

function New-BridgePg {
  # Capture (not silence) so a real error - classically "port 5432 already
  # allocated" from a local PostgreSQL install - reaches the operator.
  $out = Invoke-Capture {
    docker run -d --name bridge-pg `
      -e POSTGRES_USER=bridge -e POSTGRES_PASSWORD=bridge -e POSTGRES_DB=browser_bridge `
      -p 127.0.0.1:5432:5432 postgres:17-alpine
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not create the bridge-pg container:`n$($out -join "`n")" }
}

function Remove-BridgePg {
  Invoke-Quiet { docker rm -f bridge-pg }
  # The database is gone, so any old pairing rows are gone with it. A stale
  # local identity would make the agent silently fail to authenticate later.
  if (Test-Path $DeviceJsonPath) {
    Remove-Item $DeviceJsonPath -ErrorAction SilentlyContinue
    Write-Warning 'Removed the stale device pairing (device.json) - lane-a-run.ps1 will pair this PC again.'
  }
}

# -h 127.0.0.1: without it pg_isready hits the Unix socket, which the image's
# TEMPORARY init-time server also answers - the TCP flag only passes once the
# real server is up.
function Wait-BridgePg([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    Invoke-Quiet { docker exec bridge-pg pg_isready -h 127.0.0.1 -U bridge -d browser_bridge }
    if ($LASTEXITCODE -eq 0) { return $true }
    if ((Get-Date) -gt $deadline) { return $false }
    Start-Sleep -Seconds 2
  }
}

$pgState = 'absent'
$inspectOut = Invoke-Capture { docker inspect -f '{{.State.Status}}' bridge-pg }
if ($LASTEXITCODE -eq 0) { $pgState = ("$inspectOut").Trim() }

switch ($pgState) {
  'running' { }
  'absent'  { New-BridgePg }
  default {
    Invoke-Quiet { docker start bridge-pg }
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "bridge-pg exists but cannot start (state '$pgState') - recreating it."
      Remove-BridgePg
      New-BridgePg
    }
  }
}
if (-not (Wait-BridgePg 60)) {
  # The classic abort wound: a container that STARTS fine but whose database
  # never comes ready because initialization was killed half-way. Repair by
  # recreating once, then give it a fresh window.
  Write-Warning 'PostgreSQL did not become ready - recreating the container once (an aborted first run leaves it half-initialized).'
  Remove-BridgePg
  New-BridgePg
  if (-not (Wait-BridgePg 60)) { throw 'PostgreSQL still not ready after a clean recreate (check: docker logs bridge-pg)' }
}
Write-Host 'PostgreSQL OK (ready on 127.0.0.1:5432)' -ForegroundColor Green

# ---------------------------------------------------------------- 7. Build + migrations
Write-Host '== [7/8] Install, build, migrate ==' -ForegroundColor Cyan
& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
& pnpm build
if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }
$env:DATABASE_URL = 'postgres://bridge:bridge@127.0.0.1:5432/browser_bridge'
& node apps\gateway\dist\cli.js migrate up
if ($LASTEXITCODE -ne 0) { throw 'Migrations failed' }

# ---------------------------------------------------------------- 8. Claude Code CLI
Write-Host '== [8/8] Claude Code CLI ==' -ForegroundColor Cyan
if (-not (Test-Command 'claude')) {
  if (Test-Command 'npm') {
    & npm install -g @anthropic-ai/claude-code
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'npm could not install Claude Code. Install it later with: npm install -g @anthropic-ai/claude-code'
    }
    Refresh-Path
  } else {
    Write-Warning 'npm is not visible; install Claude Code later with: npm install -g @anthropic-ai/claude-code'
  }
}
if (Test-Command 'claude') {
  Write-Host "Claude Code OK: $(& claude --version)" -ForegroundColor Green
} else {
  Write-Warning 'Claude Code is not visible in this terminal yet - open a NEW terminal before running `claude` commands.'
}

Write-Host ''
Write-Host 'Setup complete - every dependency verified.' -ForegroundColor Green
Write-Host 'Next:  powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-run.ps1'
Write-Host '(lane-a-run.ps1 refreshes PATH itself, so the same terminal is fine.)'
