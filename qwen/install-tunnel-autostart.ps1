# ============================================================
#  Install autostart task for: Qwen model SSH tunnel + QQ bridge
#
#  Design:
#   * Action runs qq-bridge's start-all.ps1 (idempotent: skips what
#     already runs). That script waits for the network (up to 120s),
#     starts the SSH tunnel keeper, then starts the QQ bridge.
#   * Two triggers:
#       1) 20 seconds after logon
#       2) every 10 minutes (self-healing: restarts whatever died)
#   * Hidden window, no elevation (RunLevel=Limited), IgnoreNew.
#
#  Usage:
#     powershell -ExecutionPolicy Bypass -File install-tunnel-autostart.ps1
#     powershell -ExecutionPolicy Bypass -File install-tunnel-autostart.ps1 -Action status
#     powershell -ExecutionPolicy Bypass -File install-tunnel-autostart.ps1 -Action uninstall
#
#  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1
#  reads a UTF-8 file without BOM as ANSI/GBK, which breaks parsing.
# ============================================================
param([string]$Action = 'install', [string]$TaskName = 'qwen-stack-autostart')

$ErrorActionPreference = 'Stop'
$StartAll = 'BRIDGE_DIR_PLACEHOLDER\scripts\start-all.ps1'
$WorkDir  = 'BRIDGE_DIR_PLACEHOLDER'
$Me       = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME

function Show-Status {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host ("TASK '{0}': not installed" -f $TaskName); return }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host ("TASK '{0}': {1}" -f $TaskName, $t.State)
    Write-Host ("  last run : {0}   result: {1}" -f $info.LastRunTime, $info.LastTaskResult)

    $ssh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*-L 8000*' }
    $keeper = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -like '*-File*' -and $_.CommandLine -like '*tunnel.ps1*' -and $_.CommandLine -notlike '*-Command*' }
    $port = [bool](Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)
    $sshTxt    = if ($ssh)    { 'RUNNING (pid ' + ($ssh.ProcessId -join ',') + ')' } else { 'not running' }
    $keepTxt   = if ($keeper) { 'RUNNING' } else { 'not running' }
    $portTxt   = if ($port)   { 'listening' } else { 'NOT listening' }
    Write-Host ("  tunnel   : {0}" -f $sshTxt)
    Write-Host ("  keeper   : {0}" -f $keepTxt)
    Write-Host ("  port 8000: {0}" -f $portTxt)
}

if ($Action -eq 'status') { Show-Status; exit 0 }

if ($Action -eq 'uninstall') {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host ("Uninstalled task '{0}' (running tunnel/bridge are untouched)." -f $TaskName)
    exit 0
}

if (-not (Test-Path $StartAll)) { Write-Host ("Missing script: {0}" -f $StartAll) -ForegroundColor Red; exit 4 }

Write-Host '=============================================='
Write-Host ' Installing autostart task'
Write-Host '=============================================='
Write-Host ("  task name : {0}" -f $TaskName)
Write-Host ("  action    : {0}" -f $StartAll)
Write-Host ("  identity  : {0} (interactive, no elevation)" -f $Me)

$argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $StartAll
# NOTE: do NOT name this $action -- it would collide with the [string]$Action
# parameter (PowerShell variables are case-insensitive) and the object would be
# coerced to a string, making Register-ScheduledTask fail with a type error.
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $WorkDir

$tLogon = New-ScheduledTaskTrigger -AtLogOn -User $Me
$tLogon.Delay = 'PT20S'

$tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
             -RepetitionInterval (New-TimeSpan -Minutes 10) `
             -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($tLogon, $tRepeat) `
        -Settings $settings -Principal $principal `
        -Description 'Qwen3.8-27B tunnel + QQ bridge: start at logon, re-check every 10 min' `
        -Force | Out-Null
    Write-Host '  [ OK ] task registered' -ForegroundColor Green
} catch {
    Write-Host ("  [FAIL] register failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host '  (if it says access denied, re-run this script from an elevated PowerShell)' -ForegroundColor Yellow
    exit 5
}

Write-Host '  -> starting it once now to verify ...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 25
Show-Status
