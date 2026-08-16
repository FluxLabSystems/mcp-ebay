# Remove the Windows Browser Agent logon task — SDD v0.5 §13.
param(
    [string]$TaskName = "FluxologyBrowserBridgeAgent"
)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed logon task '$TaskName'."
