# Lane A launcher: brings the whole single-machine bridge up and prints the
# one-liner that attaches Claude Code to it.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-run.ps1
# (Works in Windows PowerShell 5.1 and PowerShell 7; spawned windows prefer
# PowerShell 7 when installed.)
#
# What it does, in order:
#   1. starts PostgreSQL + the gateway (DEV MODE: OAuth disabled, bound to
#      localhost - never expose this mode to the network)
#   2. runs the branded-Chrome preflight
#   3. pairs this PC with the gateway (first run only)
#   4. starts the agent in its own window (that window owns the Chrome)
#   5. prints the `claude mcp add` attach command
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot
$DbUrl = 'postgres://bridge:bridge@127.0.0.1:5432/browser_bridge'
$env:DATABASE_URL = $DbUrl

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
function Refresh-Path {
  $env:Path = $env:Path + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

# Setup may have installed node/docker/claude moments ago in THIS terminal's
# lifetime; pick up their registry PATH entries before probing.
Refresh-Path

foreach ($required in 'node', 'docker') {
  if (-not (Test-Command $required)) {
    throw "$required is not available - run scripts\windows\lane-a-setup.ps1 first (or open a NEW terminal if setup just installed it)."
  }
}
foreach ($built in 'apps\gateway\dist\server.js', 'apps\windows-agent\dist\cli.js') {
  if (-not (Test-Path $built)) {
    throw "$built is missing - the build is incomplete. Run scripts\windows\lane-a-setup.ps1 first."
  }
}

# Distinguish "Docker not running" from "container broken" - after a reboot
# the daemon is usually just still starting.
Invoke-Quiet { docker version }
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop is not running (or still starting). Start it, wait for the whale icon to settle, then re-run this script.'
}
Invoke-Quiet { docker start bridge-pg }
if ($LASTEXITCODE -ne 0) {
  throw 'The bridge-pg PostgreSQL container is missing or broken - run scripts\windows\lane-a-setup.ps1 (it creates and repairs it).'
}
# Cold boot: give the database a moment before the gateway needs it.
$deadline = (Get-Date).AddSeconds(30)
while ($true) {
  Invoke-Quiet { docker exec bridge-pg pg_isready -h 127.0.0.1 -U bridge -d browser_bridge }
  if ($LASTEXITCODE -eq 0) { break }
  if ((Get-Date) -gt $deadline) { throw 'PostgreSQL did not become ready within 30s - run scripts\windows\lane-a-setup.ps1 (it repairs the container).' }
  Start-Sleep -Seconds 2
}

# Spawned windows prefer PowerShell 7 when present; -EncodedCommand makes the
# child command immune to quoting problems (spaces or apostrophes in the repo
# path broke the plain -Command form).
$ChildShell = if (Test-Command 'pwsh') { 'pwsh' } else { 'powershell' }
function Start-ChildWindow([string]$command, [string]$windowStyle) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  if ($windowStyle) {
    Start-Process $ChildShell -ArgumentList '-NoExit', '-EncodedCommand', $encoded -WindowStyle $windowStyle
  } else {
    Start-Process $ChildShell -ArgumentList '-NoExit', '-EncodedCommand', $encoded
  }
}

function Test-Gateway {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/healthz' -TimeoutSec 2 | Out-Null
    return $true
  } catch { return $false }
}

if (-not (Test-Gateway)) {
  Write-Host '== Starting gateway (dev mode, localhost only) ==' -ForegroundColor Cyan
  $gatewayCmd = "`$env:NODE_ENV='development'; `$env:OAUTH_MODE='disabled'; " +
    "`$env:PUBLIC_BASE_URL='http://localhost:3000'; `$env:DATABASE_URL='$DbUrl'; " +
    "Set-Location -LiteralPath '$($RepoRoot -replace "'","''")'; node apps\gateway\dist\server.js"
  Start-ChildWindow $gatewayCmd 'Minimized'
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Gateway)) {
    if ((Get-Date) -gt $deadline) {
      throw 'Gateway did not answer /healthz within 30s - check the gateway window for the error'
    }
    Start-Sleep -Seconds 1
  }
}
Write-Host 'Gateway is up:  http://127.0.0.1:3000/healthz' -ForegroundColor Green

$env:AGENT_GATEWAY_URL = 'ws://127.0.0.1:3000/agent/ws'

Write-Host '== Branded-Chrome preflight ==' -ForegroundColor Cyan
& node apps\windows-agent\dist\cli.js preflight
if ($LASTEXITCODE -ne 0) {
  throw 'Preflight failed (see message above). The agent requires real Google Chrome - not Edge or Chromium. lane-a-setup.ps1 installs it.'
}

$deviceJson = Join-Path $env:LOCALAPPDATA 'Fluxology\BrowserBridge\state\device.json'
$paired = $false
if (Test-Path $deviceJson) {
  try { $paired = [bool]((Get-Content $deviceJson -Raw | ConvertFrom-Json).deviceId) } catch { $paired = $false }
}
if (-not $paired) {
  Write-Host '== Pairing this PC with the gateway (first run only) ==' -ForegroundColor Cyan
  $pairOut = Invoke-Capture { node apps\gateway\dist\cli.js device:pair --name $env:COMPUTERNAME }
  if ($LASTEXITCODE -ne 0) { throw "device:pair failed:`n$($pairOut -join "`n")" }
  $tokenMatch = $pairOut | Select-String -Pattern '^\s{2}(\S+)\s*$' | Select-Object -First 1
  if (-not $tokenMatch) { throw "Could not parse the pairing token out of:`n$($pairOut -join "`n")" }
  $token = $tokenMatch.Matches[0].Groups[1].Value
  & node apps\windows-agent\dist\cli.js pair --token $token
  if ($LASTEXITCODE -ne 0) { throw 'Pairing failed (see message above)' }
  Write-Host "Paired as device '$env:COMPUTERNAME'." -ForegroundColor Green
}

Write-Host '== Starting agent (its window owns the automation Chrome) ==' -ForegroundColor Cyan
$agentCmd = "`$env:AGENT_GATEWAY_URL='ws://127.0.0.1:3000/agent/ws'; " +
  "Set-Location -LiteralPath '$($RepoRoot -replace "'","''")'; node apps\windows-agent\dist\cli.js run"
Start-ChildWindow $agentCmd ''

Write-Host ''
Write-Host '==================================================================' -ForegroundColor Green
Write-Host ' Bridge is up: gateway (background window) + agent (new window).'
Write-Host ''
if (Test-Command 'claude') {
  Write-Host ' Attach Claude Code to it ONCE (any terminal):'
} else {
  Write-Host ' Claude Code CLI is not on PATH in this terminal. Either open a NEW'
  Write-Host ' terminal (if lane-a-setup.ps1 just installed it) or install it:'
  Write-Host '   npm install -g @anthropic-ai/claude-code' -ForegroundColor Yellow
  Write-Host ' Then attach once:'
}
Write-Host ''
Write-Host '   claude mcp add --transport http browser-bridge http://127.0.0.1:3000/mcp' -ForegroundColor Yellow
Write-Host ''
Write-Host ' Then in a claude session try:'
Write-Host '   browser.session_open (deviceId "default") -> browser.navigate'
Write-Host '   https://www.ebay.ca -> browser.snapshot / browser.extract'
Write-Host ''
Write-Host ' FIRST RUN ONLY: when the automation Chrome window appears, log into'
Write-Host ' eBay in it and set the delivery destination to your postal code.'
Write-Host ' To stop everything: close the agent and gateway windows.'
Write-Host '==================================================================' -ForegroundColor Green
