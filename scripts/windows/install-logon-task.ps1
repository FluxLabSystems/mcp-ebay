# Install the Windows Browser Agent as a per-user logon task — SDD v0.5 §13.
# The agent runs as the logged-in user (no Windows service; avoids
# session-0 browser/UI problems). Run from an elevated-or-not PowerShell
# in the repository root after `pnpm install && pnpm build`.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-logon-task.ps1 `
#     -GatewayUrl wss://browser-mcp.example.com/agent/ws

param(
    [Parameter(Mandatory = $true)]
    [string]$GatewayUrl,

    [string]$TaskName = "FluxologyBrowserBridgeAgent",

    # Path to the built agent CLI (dist output). Left empty here and resolved
    # in the body on purpose: Windows PowerShell 5.1 does not populate
    # $PSScriptRoot while param() defaults are evaluated, so the default used
    # to expand to (Join-Path '' ...) and the script died on
    # "Cannot bind argument to parameter 'Path' because it is an empty string"
    # before doing anything. PowerShell 7 does populate it, which is why this
    # only failed on a real Windows box. lane-a-run.ps1 and lane-a-setup.ps1
    # use $PSScriptRoot in the BODY and were never affected.
    [string]$AgentCli = "",

    # Resolved to an absolute path in the body. Task Scheduler does not search
    # PATH for Execute the way a shell does, so a bare "node" registers fine
    # and then fails every run with 0x80070002 (ERROR_FILE_NOT_FOUND) --
    # visible only as LastTaskResult, long after the install said "Installed".
    [string]$NodeExe = "node"
)

if ([string]::IsNullOrWhiteSpace($AgentCli)) {
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    $AgentCli = Join-Path $scriptDir "..\..\apps\windows-agent\dist\cli.js"
}

# Register an absolute path, never a bare command name: Task Scheduler resolves
# Execute itself and does not use the shell's PATH lookup, so "node" installs
# cleanly and then fails every run with 0x80070002.
if (-not (Test-Path -LiteralPath $NodeExe)) {
    $nodeCommand = Get-Command $NodeExe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw "Could not resolve '$NodeExe' to an executable. Install Node.js 22.12 or newer, or pass -NodeExe <full path to node.exe>."
    }
    $NodeExe = $nodeCommand.Source
}

# Resolve-Path throws a bare "Cannot find path" for a missing dist build, which
# is the most common state to run this in (the agent is built by `pnpm build`,
# a separate step). Say what to do instead.
if (-not (Test-Path -LiteralPath $AgentCli)) {
    throw "Agent CLI not found at $AgentCli - run 'corepack enable; pnpm install --frozen-lockfile; pnpm build' in the repository root first, or pass -AgentCli <path to cli.js>."
}
$AgentCliResolved = (Resolve-Path -LiteralPath $AgentCli).Path

$action = New-ScheduledTaskAction `
    -Execute $NodeExe `
    -Argument "`"$AgentCliResolved`" run" `
    -WorkingDirectory (Split-Path $AgentCliResolved)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Fluxology Browser Bridge Windows agent (outbound WSS; controls the dedicated Chrome automation profile)" `
    -Force | Out-Null

# The task inherits the user environment; persist AGENT_GATEWAY_URL for the user.
[Environment]::SetEnvironmentVariable("AGENT_GATEWAY_URL", $GatewayUrl, "User")

Write-Host "Installed logon task '$TaskName'."
Write-Host "  node:  $NodeExe"
Write-Host "AGENT_GATEWAY_URL set to $GatewayUrl (user environment)."
Write-Host "Pair the device first:  node `"$AgentCliResolved`" pair --token <one-time-token>"
Write-Host "Start now without re-logon:  Start-ScheduledTask -TaskName $TaskName"
