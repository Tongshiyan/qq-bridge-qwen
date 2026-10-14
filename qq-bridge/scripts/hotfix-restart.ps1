# ============================================================
#  One-shot: restart the QQ bridge after a code hotfix.
#  Created by the DSH agent on 2026-10-12 (SEND_FILE marker fix).
#  Run by a one-time scheduled task; deletes itself when done.
#
#  NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads
#  UTF-8 without BOM as ANSI/GBK).
# ============================================================
$BridgeDir = '%BRIDGE_DIR%'
$log       = Join-Path $BridgeDir 'logs\hotfix-restart.log'

function Log($m) {
  Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log 'hotfix-restart: start'

try {
  $lock = Get-Content (Join-Path $BridgeDir 'state\bridge.lock') -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($lock.pid -and (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $lock.pid -Force
    Log ("killed bridge pid " + $lock.pid)
  } else {
    Log 'bridge not running per lock - nothing to kill'
  }
} catch {
  Log ('lock read failed: ' + $_.Exception.Message)
}

Start-Sleep -Seconds 6

& (Join-Path $BridgeDir 'scripts\start-all.ps1')
Log 'start-all invoked'

# Verify the bridge came back (start-all may wait for network up to ~120s).
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  try {
    $lock2 = Get-Content (Join-Path $BridgeDir 'state\bridge.lock') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($lock2.pid -and (Get-Process -Id $lock2.pid -ErrorAction SilentlyContinue)) { $ok = $true; break }
  } catch { }
}
if ($ok) { Log 'bridge is back: pid ' + $lock2.pid } else { Log 'WARNING: bridge did not come back within 60s' }

# Self-cleanup (best effort; a leftover one-time task is harmless).
schtasks.exe /delete /tn dsh-bridge-hotfix-restart /f 2>$null | Out-Null
Log 'self-cleanup attempted'
Log 'hotfix-restart: done'
