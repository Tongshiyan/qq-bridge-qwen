# ============================================================
#  Disable / restore ALL autostart of the Qwen service stack
#  (SSH tunnel + QQ bridge).  Nothing is deleted: the startup
#  entry is MOVED into disabled-autostart\ so it can be restored.
#
#  Manual start (after disabling):
#    tunnel only : double-click  QWEN_DIR_PLACEHOLDER\start-tunnel.cmd
#    full stack  : BRIDGE_DIR_PLACEHOLDER\scripts\start-all.cmd
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File disable-autostart.ps1
#    powershell -ExecutionPolicy Bypass -File disable-autostart.ps1 -Restore
#    powershell -ExecutionPolicy Bypass -File disable-autostart.ps1 -Status
#
#  NOTE: ASCII-only. Windows PowerShell 5.1 reads a UTF-8 file
#  without BOM as ANSI/GBK and then fails to parse it.
# ============================================================
param([switch]$Restore, [switch]$Status)

$Backup  = 'QWEN_DIR_PLACEHOLDER\disabled-autostart'
$Startup = [Environment]::GetFolderPath('Startup')
$TaskName = 'qwen-stack-autostart'
$Patterns = @('*QQ-Robot*', '*tunnel*', '*qwen*')

function Get-AutostartFiles {
    Get-ChildItem -LiteralPath $Startup -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $n = $_.Name; ($Patterns | Where-Object { $n -like $_ }).Count -gt 0 }
}

function Show-State {
    Write-Host '--- scheduled task ---'
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Write-Host ("  {0}: {1}" -f $TaskName, $t.State) }
    else    { Write-Host ("  {0}: not installed" -f $TaskName) }

    Write-Host '--- Startup folder ---'
    $files = Get-AutostartFiles
    if ($files) { $files | ForEach-Object { Write-Host ("  ACTIVE: {0}" -f $_.Name) } }
    else        { Write-Host '  (no qwen/QQ startup entry)' }

    Write-Host '--- disabled backup ---'
    $bak = Get-ChildItem -LiteralPath $Backup -File -Force -ErrorAction SilentlyContinue
    if ($bak) { $bak | ForEach-Object { Write-Host ("  {0}" -f $_.Name) } }
    else      { Write-Host '  (empty)' }

    Write-Host '--- running now ---'
    $ssh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*-L 8000*' }
    $keeper = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -like '*-File*' -and $_.CommandLine -like '*tunnel.ps1*' -and $_.CommandLine -notlike '*-Command*' }
    $port = [bool](Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)
    Write-Host ("  tunnel process : {0}" -f $(if ($ssh) { 'RUNNING (pid ' + ($ssh.ProcessId -join ',') + ')' } else { 'not running' }))
    Write-Host ("  tunnel keeper  : {0}" -f $(if ($keeper) { 'RUNNING' } else { 'not running' }))
    Write-Host ("  port 8000      : {0}" -f $(if ($port) { 'listening' } else { 'not listening' }))
}

if ($Status) { Show-State; exit 0 }

if (-not (Test-Path -LiteralPath $Backup)) { New-Item -ItemType Directory -Path $Backup -Force | Out-Null }

if ($Restore) {
    Write-Host '=== RESTORE autostart ==='
    $bak = Get-ChildItem -LiteralPath $Backup -File -Force -ErrorAction SilentlyContinue
    foreach ($f in $bak) {
        Move-Item -LiteralPath $f.FullName -Destination (Join-Path $Startup $f.Name) -Force
        Write-Host ("  restored to Startup: {0}" -f $f.Name)
    }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Enable-ScheduledTask -TaskName $TaskName | Out-Null
        Write-Host ("  enabled task: {0}" -f $TaskName)
    }
    Write-Host ''
    Show-State
    exit 0
}

Write-Host '=== DISABLE autostart ==='

$moved = 0
foreach ($f in (Get-AutostartFiles)) {
    Move-Item -LiteralPath $f.FullName -Destination (Join-Path $Backup $f.Name) -Force
    Write-Host ("  moved out of Startup: {0}" -f $f.Name)
    $moved++
}
if ($moved -eq 0) { Write-Host '  (Startup folder had no qwen/QQ entry)' }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    Write-Host ("  disabled task: {0}" -f $TaskName)
}

Write-Host ''
Show-State
Write-Host ''
Write-Host 'Autostart is off. Running processes above are left untouched.'
Write-Host 'Manual start: qwen\start-tunnel.cmd  (tunnel only, visible window)'
Write-Host '              qq-bridge\scripts\start-all.cmd  (tunnel + QQ bridge)'
