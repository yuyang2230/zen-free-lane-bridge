<#
    install-windows-task.ps1 — deploy zen-bridge (and optionally the opencode
    server it rides on) as Windows scheduled tasks.

    Creates task "ZenBridge" (and with -Component ocserver|both, "ZenOcServer")
    that start at logon through hidden VBS wrappers, with self-restarting
    launch loops.

    Run:  powershell -ExecutionPolicy Bypass -File deploy\install-windows-task.ps1 [-Component bridge|ocserver|both]
#>

[CmdletBinding()]
param(
    [ValidateSet("bridge", "ocserver", "both")]
    [string]$Component = "both",
    [string]$BridgeTaskName = "ZenBridge",
    [string]$OcServerTaskName = "ZenOcServer"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command opencode -ErrorAction SilentlyContinue) -and $Component -ne "bridge") {
    throw "the 'opencode' CLI is required for the ocserver component (https://opencode.ai)"
}

function Install-Task {
    param([string]$Name, [string]$VbsPath, [string]$Description)
    if (-not (Test-Path $VbsPath)) { throw "missing $VbsPath" }
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "replacing existing task '$Name'"
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
    $action = New-ScheduledTaskAction `
        -Execute "wscript.exe" `
        -Argument ('"{0}"' -f $VbsPath) `
        -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Settings $settings -Description $Description | Out-Null
    Start-ScheduledTask -TaskName $Name
    Write-Host "installed and started: $Name"
}

if ($Component -in "bridge", "both") {
    $cmd = Join-Path $repoRoot "bridge\start-bridge.cmd"
    if (-not (Test-Path $cmd)) { throw "missing $cmd" }
    Install-Task -Name $BridgeTaskName `
        -VbsPath (Join-Path $PSScriptRoot "start-bridge-hidden.vbs") `
        -Description "zen-bridge: OpenCode Zen free-lane bridge for AI gateways"
}

if ($Component -in "ocserver", "both") {
    $cmd = Join-Path $PSScriptRoot "start-ocserver.cmd"
    if (-not (Test-Path $cmd)) { throw "missing $cmd" }
    Install-Task -Name $OcServerTaskName `
        -VbsPath (Join-Path $PSScriptRoot "start-ocserver-hidden.vbs") `
        -Description "headless opencode server backend for zen-bridge ocserver mode"
}

Start-Sleep -Seconds 4
Write-Host ""
Write-Host "health check:"
Write-Host "  Invoke-RestMethod http://127.0.0.1:8799/health | ConvertTo-Json -Depth 4"
Write-Host ""
Write-Host "stop:    Stop-ScheduledTask  -TaskName <name>"
Write-Host "remove:  Unregister-ScheduledTask -TaskName <name> -Confirm:`$false"