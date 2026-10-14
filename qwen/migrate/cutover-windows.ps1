# ============================================================
#  Cut the Windows-side SSH tunnel over to the new 2-GPU host.
#
#  Stops the current keeper + ssh tunnel (whatever host they point at),
#  starts a fresh hidden keeper bound to -Server, then verifies that
#  local 8000 answers HTTP 200 through the tunnel.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File cutover-windows.ps1
#    powershell -ExecutionPolicy Bypass -File cutover-windows.ps1 -Server user@your-server-ip
#    powershell -ExecutionPolicy Bypass -File cutover-windows.ps1 -StatusOnly
#
#  NOTE: keep this file ASCII-only (PowerShell 5.1 + UTF-8 without BOM).
# ============================================================
param(
    [string]$Server = 'user@your-server-ip',
    [int]$LocalPort = 8000,
    [switch]$StatusOnly
)

$ErrorActionPreference = 'Continue'
$QwenDir  = 'D:\dsh-workspace\qwen'
$TunnelPs = Join-Path $QwenDir 'tunnel.ps1'
$LogDir   = Join-Path $QwenDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Get-TunnelSsh {
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*-L $LocalPort*" }
}
function Get-TunnelKeeper {
    # Identify keepers two ways, because some are launched with -EncodedCommand
    # and their command line contains no "tunnel.ps1" text at all:
    #   1) the parent process of a live `ssh -L <port>` child, or
    #   2) the classic `-File ...\tunnel.ps1` invocation.
    $parents = @{}
    foreach ($s in @(Get-TunnelSsh)) { $parents[[int]$s.ParentProcessId] = $true }
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessId -ne $PID -and (
                $parents.ContainsKey([int]$_.ProcessId) -or
                ($_.CommandLine -like '*tunnel.ps1*' -and $_.CommandLine -notlike '*-Command*')
            )
        }
}
function Get-ApiCode {
    $c = & curl.exe -sS -m 6 -o NUL -w '%{http_code}' "http://127.0.0.1:$LocalPort/v1/models" -H 'Authorization: Bearer local-any-string' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $c) { return '000' }
    return "$c".Trim()
}

function Show-State {
    Write-Host '--- tunnel ssh ---'
    $ssh = @(Get-TunnelSsh)
    if ($ssh) { $ssh | ForEach-Object { Write-Host ("  pid {0}: {1}" -f $_.ProcessId, $_.CommandLine) } }
    else { Write-Host '  (none)' }
    Write-Host '--- keeper ---'
    $k = @(Get-TunnelKeeper)
    if ($k) { $k | ForEach-Object { Write-Host ("  pid {0}" -f $_.ProcessId) } }
    else { Write-Host '  (none)' }
    Write-Host '--- local port / API ---'
    $lis = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
    Write-Host ("  port {0}: {1}" -f $LocalPort, $(if ($lis) { 'listening' } else { 'NOT listening' }))
    Write-Host ("  /v1/models HTTP: {0}" -f (Get-ApiCode))
}

if ($StatusOnly) { Show-State; exit 0 }

Write-Host '=============================================='
Write-Host ' Qwen tunnel cutover'
Write-Host (' target: {0}  ->  local 127.0.0.1:{1}' -f $Server, $LocalPort)
Write-Host '=============================================='
Write-Host '== before =='
Show-State

Write-Host ''
Write-Host '== stopping old keeper + tunnel =='
foreach ($k in @(Get-TunnelKeeper)) {
    Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ("  stopped keeper pid {0}" -f $k.ProcessId)
}
foreach ($s in @(Get-TunnelSsh)) {
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ("  stopped ssh pid {0}" -f $s.ProcessId)
}
Start-Sleep -Seconds 3

Write-Host ''
Write-Host '== starting new hidden keeper =='
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $TunnelPs, '-Server', $Server)
Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'tunnel-stdout.log') `
    -RedirectStandardError  (Join-Path $LogDir 'tunnel-stderr.log') | Out-Null
Write-Host '  keeper started'

Write-Host ''
Write-Host '== waiting for the tunnel to come up =='
$ok = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 3
    $lis  = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
    $code = Get-ApiCode
    Write-Host ("  attempt {0,2}: port={1,-13} http={2}" -f $i, $(if ($lis) { 'listening' } else { 'not listening' }), $code)
    if ($code -eq '200') { $ok = $true; break }
}
Write-Host ''
if ($ok) {
    Write-Host '  [ OK ] tunnel up and the API answers HTTP 200 through it' -ForegroundColor Green
} else {
    Write-Host '  [FAIL] tunnel did not reach HTTP 200 in 90s' -ForegroundColor Red
    Write-Host '         check: logs\tunnel-stderr.log, and whether the remote service is up'
}
Write-Host ''
Show-State
exit $(if ($ok) { 0 } else { 1 })
