<#
    install-windows-task.ps1 — deploy zen-bridge as a Windows scheduled task.

    Creates task "ZenBridge" that starts at logon, runs the launcher through a
    hidden VBS window, and keeps itself alive via start-bridge.cmd's restart loop.

    Run:  powershell -ExecutionPolicy Bypass -File deploy\install-windows-task.ps1
#>

[CmdletBinding()]
param(
    [string]$TaskName = "ZenBridge"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot "start-bridge-hidden.vbs"
$cmd = Join-Path $repoRoot "bridge\start-bridge.cmd"

if (-not (Test-Path $vbs)) { throw "missing $vbs" }
if (-not (Test-Path $cmd)) { throw "missing $cmd" }

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "node.exe" }

Write-Host "repo : $repoRoot"
Write-Host "node : $node"

# Remove any previous instance so this script is idempotent.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "replacing existing task '$TaskName'"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument ('"{0}"' -f $vbs) `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "zen-bridge: OpenCode Zen free-lane bridge for AI gateways" | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

Write-Host ""
Write-Host "installed and started: $TaskName"
Write-Host "health check:"
Write-Host "  Invoke-RestMethod http://127.0.0.1:8799/health | ConvertTo-Json"
Write-Host ""
Write-Host "stop:    Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "remove:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"