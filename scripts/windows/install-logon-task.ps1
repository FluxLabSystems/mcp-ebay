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

    # Path to the built agent CLI (dist output).
    [string]$AgentCli = (Join-Path $PSScriptRoot "..\..\apps\windows-agent\dist\cli.js"),

    [string]$NodeExe = "node"
)

$AgentCliResolved = (Resolve-Path $AgentCli).Path

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
Write-Host "AGENT_GATEWAY_URL set to $GatewayUrl (user environment)."
Write-Host "Pair the device first:  node `"$AgentCliResolved`" pair --token <one-time-token>"
Write-Host "Start now without re-logon:  Start-ScheduledTask -TaskName $TaskName"
