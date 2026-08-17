# Lane A launcher: brings the whole single-machine bridge up and prints the
# one-liner that attaches Claude Code to it.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-run.ps1
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

& docker start bridge-pg *> $null

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
    "Set-Location '$RepoRoot'; node apps\gateway\dist\server.js"
  Start-Process powershell -ArgumentList '-NoExit', '-Command', $gatewayCmd -WindowStyle Minimized
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Gateway)) {
    if ((Get-Date) -gt $deadline) {
      throw 'Gateway did not answer /healthz within 30s - check the minimized gateway window for the error'
    }
    Start-Sleep -Seconds 1
  }
}
Write-Host 'Gateway is up:  http://127.0.0.1:3000/healthz' -ForegroundColor Green

$env:AGENT_GATEWAY_URL = 'ws://127.0.0.1:3000/agent/ws'

Write-Host '== Branded-Chrome preflight ==' -ForegroundColor Cyan
& node apps\windows-agent\dist\cli.js preflight
if ($LASTEXITCODE -ne 0) {
  throw 'Preflight failed (see message above). The agent requires real Google Chrome - not Edge or Chromium.'
}

$deviceJson = Join-Path $env:LOCALAPPDATA 'Fluxology\BrowserBridge\state\device.json'
$paired = $false
if (Test-Path $deviceJson) {
  try { $paired = [bool]((Get-Content $deviceJson -Raw | ConvertFrom-Json).deviceId) } catch { $paired = $false }
}
if (-not $paired) {
  Write-Host '== Pairing this PC with the gateway (first run only) ==' -ForegroundColor Cyan
  $pairOut = & node apps\gateway\dist\cli.js device:pair --name $env:COMPUTERNAME 2>&1
  $tokenMatch = $pairOut | Select-String -Pattern '^\s{2}(\S+)\s*$' | Select-Object -First 1
  if (-not $tokenMatch) { throw "Could not parse the pairing token out of:`n$($pairOut -join "`n")" }
  $token = $tokenMatch.Matches[0].Groups[1].Value
  & node apps\windows-agent\dist\cli.js pair --token $token
  if ($LASTEXITCODE -ne 0) { throw 'Pairing failed (see message above)' }
  Write-Host "Paired as device '$env:COMPUTERNAME'." -ForegroundColor Green
}

Write-Host '== Starting agent (its window owns the automation Chrome) ==' -ForegroundColor Cyan
$agentCmd = "`$env:AGENT_GATEWAY_URL='ws://127.0.0.1:3000/agent/ws'; " +
  "Set-Location '$RepoRoot'; node apps\windows-agent\dist\cli.js run"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $agentCmd

Write-Host ''
Write-Host '==================================================================' -ForegroundColor Green
Write-Host ' Bridge is up: gateway (minimized window) + agent (new window).'
Write-Host ''
Write-Host ' Attach Claude Code to it ONCE (any terminal):'
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
