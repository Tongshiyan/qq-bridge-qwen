# ============================================================
#  Start the QQ robot stack as BACKGROUND processes (no window):
#    1) SSH tunnel  (local 8000 -> qwen server 8000, ssh -C)
#    2) QQ bridge   (qq-bridge, connects to the QQ gateway)
#
#  Idempotent: anything already running is left alone.
#
#  Why PowerShell and not a .cmd: this script launches both children
#  with Start-Process -WindowStyle Hidden (and the bridge is launched
#  as Electron-as-Node, a GUI-subsystem binary that never allocates a
#  console). The previous .cmd version left a minimized console window
#  each in the taskbar, which is exactly what we are removing.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File start-all.ps1
#    powershell -ExecutionPolicy Bypass -File start-all.ps1 status
#
#  Log: logs\autostart.log
#
#  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a
#  UTF-8 file without BOM as ANSI/GBK, which corrupts non-ASCII text
#  and can break parsing (already bitten once in tunnel.ps1).
# ============================================================
param([string]$Mode = 'start')

$TunnelPs  = 'QWEN_DIR_PLACEHOLDER\tunnel.ps1'
$BridgeDir = 'BRIDGE_DIR_PLACEHOLDER'
$Electron  = 'DSH_EXE_PLACEHOLDER'
$LogDir    = Join-Path $BridgeDir 'logs'
$Log       = Join-Path $LogDir 'autostart.log'
$Server    = 'your-server-ip'
$QqHost    = 'api.sgroup.qq.com'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $Log -Value $line
}

# ssh.exe with -L 8000 is airtight (our own process can never match it);
# the keeper check must skip -Command shells, otherwise the probe itself
# (its command text contains "tunnel.ps1") always reports RUNNING.
function Test-TunnelRunning {
  $ssh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
         Where-Object { $_.CommandLine -like '*-L 8000*' }
  if ($ssh) { return $true }
  $keeper = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
            Where-Object {
              $_.ProcessId -ne $PID -and
              $_.CommandLine -like '*-File*' -and
              $_.CommandLine -like '*tunnel.ps1*' -and
              $_.CommandLine -notlike '*-Command*'
            }
  return [bool]$keeper
}

# Read the bridge's own lock instead of scanning command lines: any shell
# whose command text merely mentions main.js would match a scan.
function Test-BridgeRunning {
  $lock = Join-Path $BridgeDir 'state\bridge.lock'
  if (-not (Test-Path $lock)) { return $false }
  try {
    $l = Get-Content $lock -Raw | ConvertFrom-Json
    if ($l.pid -and (Get-Process -Id $l.pid -ErrorAction SilentlyContinue)) { return $true }
  } catch { }
  return $false
}

function Test-Network {
  $a = Test-Connection -ComputerName $Server -Count 1 -Quiet -ErrorAction SilentlyContinue
  if (-not $a) { return $false }
  $b = Test-Connection -ComputerName $QqHost -Count 1 -Quiet -ErrorAction SilentlyContinue
  return [bool]$b
}

# The thinking-off proxy is detected by its listening port: the probe's own
# command line contains no port pattern, so this cannot match itself.
function Test-ProxyRunning {
  $c = Get-NetTCPConnection -LocalPort 8002 -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

if ($Mode -eq 'status') {
  if (Test-TunnelRunning) { Write-Host 'tunnel: RUNNING' } else { Write-Host 'tunnel: stopped' }
  if (Test-BridgeRunning) { Write-Host 'bridge: RUNNING' } else { Write-Host 'bridge: stopped' }
  if (Test-ProxyRunning) { Write-Host 'proxy(thinking-off): RUNNING' } else { Write-Host 'proxy(thinking-off): stopped' }
  exit 0
}

Write-Log '---- start-all invoked ----'

# ---- launch-context guard ------------------------------------------------
# Why this exists (real incident, 2026-10-14):
#   This script was run from inside a DSH agent session, i.e. inside DSH's
#   Windows file sandbox. The sandbox is a low-integrity token and children
#   inherit it, so the bridge it started could spawn `dsh --profile headless`
#   but that child failed on its very first write:
#       Error: EPERM: operation not permitted, open
#         'C:\Users\<you>\.dsh\profiles\headless\cordis.yml'
#   => every QQ instruction failed in ~0.1s with a Node crash dump.
#
#   The workspace is writable there (DSH grants it), everything outside is not,
#   so the honest test is: can we write inside the DSH config folder?
#   Refuse loudly instead of starting a bridge that can only fail.
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProbeDir = if (Test-Path (Join-Path $DshHome 'profiles')) { Join-Path $DshHome 'profiles' } else { $DshHome }
$ProbeFile = Join-Path $ProbeDir ('.start-all-write-probe-' + $PID + '.tmp')
$CanWriteDsh = $false
try {
  Set-Content -LiteralPath $ProbeFile -Value 'probe' -ErrorAction Stop
  Remove-Item -LiteralPath $ProbeFile -Force -ErrorAction SilentlyContinue
  $CanWriteDsh = $true
} catch {
  $CanWriteDsh = $false
}

if (-not $CanWriteDsh) {
  Write-Log ('REFUSED: cannot write ' + $ProbeDir + ' - started inside a sandbox?')
  Write-Host ''
  Write-Host 'REFUSED: this process cannot write the DSH config folder:' -ForegroundColor Red
  Write-Host ('  ' + $ProbeDir) -ForegroundColor Red
  Write-Host ''
  Write-Host '  Reason: it is running inside a DSH file sandbox (low integrity token).'
  Write-Host '          Children inherit that token, so the bridge started from here'
  Write-Host '          cannot let `dsh` rewrite its profile, and every task dies with'
  Write-Host '             EPERM ... .dsh\profiles\<profile>\cordis.yml'
  Write-Host ''
  Write-Host '  Fix: start it from a normal (non-sandboxed) shell or by double-click:'
  Write-Host '             scripts\start-all.cmd'
  Write-Host ''
  exit 7
}

# At logon this can win the race against Wi-Fi / the aTrust VPN. The tunnel
# keeper retries by itself, but the bridge exits when the gateway is not
# reachable, so wait here first (up to ~2 minutes).
$waited = 0
while ($waited -lt 40 -and -not (Test-Network)) { Start-Sleep -Seconds 3; $waited++ }
if (Test-Network) { Write-Log 'network OK' } else { Write-Log 'network not fully up after ~120s; starting anyway' }

if (Test-TunnelRunning) {
  Write-Log 'tunnel already running - skip'
} else {
  Write-Log 'starting tunnel (hidden) ...'
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $TunnelPs `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'tunnel-stdout.log') `
    -RedirectStandardError  (Join-Path $LogDir 'tunnel-stderr.log') | Out-Null
}

if (Test-BridgeRunning) {
  Write-Log 'bridge already running - skip'
} else {
  Write-Log 'starting bridge (hidden, Electron-as-Node) ...'
  # No console window: the Electron binary is a GUI-subsystem executable.
  $env:ELECTRON_RUN_AS_NODE = '1'
  Start-Process -FilePath $Electron -ArgumentList 'src\main.js' -WorkingDirectory $BridgeDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'bridge-stdout.log') `
    -RedirectStandardError  (Join-Path $LogDir 'bridge-stderr.log') | Out-Null
}

# ---- thinking-off proxy ------------------------------------------
# The robot's model is reached through a tiny local proxy that injects
# chat_template_kwargs.enable_thinking=false (see src/proxy/thinking-off.js
# and the headless profile's baseURL). Without it every agent step pays for
# reasoning tokens the robot does not need.
if (Test-ProxyRunning) {
  Write-Log 'thinking-off proxy already running - skip'
} else {
  Write-Log 'starting thinking-off proxy (hidden) ...'
  $env:ELECTRON_RUN_AS_NODE = '1'
  Start-Process -FilePath $Electron `
    -ArgumentList 'src\proxy\thinking-off.js', '--listen', '8002', '--upstream', 'http://127.0.0.1:8000' `
    -WorkingDirectory $BridgeDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'thinking-off.log') `
    -RedirectStandardError  (Join-Path $LogDir 'thinking-off-err.log') | Out-Null
}

Write-Log '---- start-all finished ----'
exit 0
