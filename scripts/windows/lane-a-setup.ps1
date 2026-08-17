# Lane A one-time setup: everything the single-machine bridge needs, idempotent.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-setup.ps1
# Re-run safely after every `git pull` (it rebuilds and re-applies migrations).
#
# Prerequisites you install once by hand (the script only verifies them):
#   - Node.js >= 22.12          https://nodejs.org
#   - Docker Desktop (running)  https://docker.com
#   - Google Chrome (branded)   the agent refuses Edge/Chromium substitutes
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

Write-Host '== Checking prerequisites ==' -ForegroundColor Cyan
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw 'Node.js is not installed or not on PATH (need >= 22.12): https://nodejs.org' }
if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.12.0') {
  throw "Node $nodeVersion is too old; the bridge needs >= 22.12"
}
& docker version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop must be installed AND running before setup' }

Write-Host '== Installing and building (pnpm) ==' -ForegroundColor Cyan
& corepack enable
if ($LASTEXITCODE -ne 0) { throw 'corepack enable failed - run this shell as Administrator once, then retry' }
& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
& pnpm build
if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }

Write-Host '== PostgreSQL (bridge-pg container, localhost only) ==' -ForegroundColor Cyan
$existing = & docker ps -a --filter name='^bridge-pg$' --format '{{.Names}}'
if ($existing -ne 'bridge-pg') {
  & docker run -d --name bridge-pg `
    -e POSTGRES_USER=bridge -e POSTGRES_PASSWORD=bridge -e POSTGRES_DB=browser_bridge `
    -p 127.0.0.1:5432:5432 postgres:17-alpine | Out-Null
} else {
  & docker start bridge-pg | Out-Null
}
$deadline = (Get-Date).AddSeconds(60)
while ($true) {
  & docker exec bridge-pg pg_isready -U bridge *> $null
  if ($LASTEXITCODE -eq 0) { break }
  if ((Get-Date) -gt $deadline) { throw 'PostgreSQL did not become ready within 60s (check: docker logs bridge-pg)' }
  Start-Sleep -Seconds 2
}

Write-Host '== Applying database migrations ==' -ForegroundColor Cyan
$env:DATABASE_URL = 'postgres://bridge:bridge@127.0.0.1:5432/browser_bridge'
& node apps\gateway\dist\cli.js migrate up
if ($LASTEXITCODE -ne 0) { throw 'Migrations failed' }

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Next:  powershell -ExecutionPolicy Bypass -File scripts\windows\lane-a-run.ps1'
