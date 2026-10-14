# ============================================================
#  QQ Bot permission verification -- step 1 + step 2 runner
#
#  Usage:
#    .\verify.cmd                      interactive prompt, mode=target
#    .\verify.cmd all                  full comparison test
#    .\verify.cmd baseline             control test only
#    .\verify.cmd zero                 connectivity-only test
#    .\verify.cmd target -SaveCreds    run and cache credentials
#    .\verify.cmd -ClearCreds          delete cached credentials
#
#  Prefer verify.cmd over calling this file directly: this machine's
#  PowerShell execution policy blocks unsigned .ps1 files.
#
#  NOTE: This file is intentionally ASCII-only. Windows PowerShell
#  5.1 reads .ps1 files using the system ANSI code page (GBK on a
#  Chinese Windows), so non-ASCII characters here would be decoded
#  incorrectly and break parsing. Keep user-facing Chinese text in
#  the .js files instead -- Node always reads those as UTF-8.
# ============================================================

[CmdletBinding()]
param(
    # NOTE: these three have NO defaults on purpose.
    #
    # cmd.exe injects an empty string as the first argument because the
    # launcher expands "%~dp0verify.ps1" (trailing backslash). PowerShell
    # binds POSITIONALLY, so a command written as `verify.cmd all` used to
    # bind the literal word "all" to -AppId and call the API with
    # AppID="all" (error 100007). Leaving these unset lets us detect and
    # repair that below instead of silently sending garbage.
    [string]$AppId,
    [string]$AppSecret,
    [string]$Mode,
    [switch]$SkipToken,
    [switch]$SaveCreds,
    [switch]$ClearCreds
)

$ValidModes = @('target', 'baseline', 'zero', 'all')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root 'bin\node.cmd'
$credsPath = Join-Path $root 'config\creds.json'

function Write-Head([string]$t) {
    Write-Host ''
    Write-Host ('=' * 64) -ForegroundColor Cyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('=' * 64) -ForegroundColor Cyan
}

# ---------------------------------------------------------- preflight

if (-not (Test-Path $node)) {
    Write-Host "[FAIL] Node wrapper not found: $node" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------- clear creds

if ($ClearCreds) {
    if (Test-Path $credsPath) {
        Remove-Item $credsPath -Force
        Write-Host "[ OK ] Deleted cached credentials: $credsPath" -ForegroundColor Green
    }
    else {
        Write-Host "[INFO] No cached credentials found." -ForegroundColor Yellow
    }
    exit 0
}

# ------------------------------------------------- mode-word repair
#
# Self-heal the `verify.cmd all` mistake described in the param block:
# if -AppId holds a mode word, that value was meant for -Mode.

if ($AppId -and ($ValidModes -contains $AppId.ToLower())) {
    if (-not $Mode) { $Mode = $AppId.ToLower() }
    Write-Host "[FIX ] '$AppId' was bound to -AppId (positional binding);" -ForegroundColor Magenta
    Write-Host "       treating it as -Mode instead. Use -Mode $Mode to avoid this." -ForegroundColor Magenta
    $AppId = ''
}

if (-not $Mode) { $Mode = 'target' }

if ($ValidModes -notcontains $Mode.ToLower()) {
    Write-Host "[FAIL] Invalid mode: '$Mode'. Valid: $($ValidModes -join ' | ')" -ForegroundColor Red
    Write-Host '       Correct usage: verify.cmd -Mode all' -ForegroundColor Red
    exit 2
}
$Mode = $Mode.ToLower()

# ---------------------------------------------------------- load creds

if ((-not $AppId -or -not $AppSecret) -and (Test-Path $credsPath)) {
    try {
        $saved = Get-Content $credsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $AppId) { $AppId = $saved.appId }
        if (-not $AppSecret) { $AppSecret = $saved.appSecret }
        Write-Host "[INFO] Loaded credentials from config\creds.json" -ForegroundColor DarkGray
    }
    catch {
        Write-Host "[WARN] Could not read cached credentials; will prompt." -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------- prompt

if (-not $AppId) {
    Write-Host ''
    Write-Host 'Enter QQ Bot AppID (visible in the open-platform console):' -ForegroundColor Yellow
    # Read-Host returns $null when stdin is closed/empty (e.g. a
    # non-interactive call), so guard before Trim().
    $entered = Read-Host '  AppID'
    $AppId = if ($null -eq $entered) { '' } else { $entered.Trim() }
}

if (-not $AppSecret) {
    Write-Host 'Enter AppSecret (input hidden):' -ForegroundColor Yellow
    $sec = Read-Host '  AppSecret' -AsSecureString
    if ($null -ne $sec) {
        $plain = [System.Net.NetworkCredential]::new('', $sec).Password
        $AppSecret = if ($plain) { $plain.Trim() } else { '' }
    }
    else {
        $AppSecret = ''
    }
}

if (-not $AppId -or -not $AppSecret) {
    Write-Host '[FAIL] AppID and AppSecret are both required.' -ForegroundColor Red
    exit 2
}

# ---------------------------------------------------------- sanity check
#
# Catch obviously-wrong credentials BEFORE spending a request. This also
# stops the `-SaveCreds` path from persisting garbage into creds.json,
# where it would poison every later run.

$looksWrong = $false

if ($AppId -match '^(all|target|baseline|zero|test|xxx|a+)$') {
    Write-Host "[WARN] AppID '$AppId' does not look like a real AppID." -ForegroundColor Yellow
    $looksWrong = $true
}
elseif ($AppId -notmatch '^\d{5,}$') {
    Write-Host "[WARN] AppID '$AppId' is not a plausible value (real AppIDs are numeric)." -ForegroundColor Yellow
    $looksWrong = $true
}

if ($AppId -eq $AppSecret) {
    Write-Host '[WARN] AppID and AppSecret are identical; one of them was mis-entered.' -ForegroundColor Yellow
    $looksWrong = $true
}

if ($looksWrong) {
    Write-Host ''
    Write-Host 'The request would be sent with these values and rejected by the API.' -ForegroundColor Yellow
    Write-Host 'Fix them first, e.g.:' -ForegroundColor Yellow
    Write-Host '  verify.cmd -AppId <your numeric AppID> -AppSecret <secret> -Mode all' -ForegroundColor Yellow
    Write-Host '  verify.cmd -Mode all' -ForegroundColor Yellow
    Write-Host '  verify.cmd -ClearCreds      (drop any cached bad values)' -ForegroundColor Yellow
    exit 2
}

# ---------------------------------------------------------- optional save

if ($SaveCreds) {
    $dir = Split-Path $credsPath -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # IMPORTANT: write WITHOUT a BOM. `Set-Content -Encoding UTF8` emits a
    # UTF-8 BOM on Windows PowerShell 5.1, and JSON.parse rejects a BOM,
    # which would make every downstream reader fail on this file.
    $json = @{ appId = $AppId; appSecret = $AppSecret } | ConvertTo-Json
    [System.IO.File]::WriteAllText($credsPath, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[WARN] Credentials saved to $credsPath" -ForegroundColor Yellow
    Write-Host '       Make sure this file is never committed or cloud-synced.' -ForegroundColor Yellow
}

# ---------------------------------------------------------- run

$overall = 0

if (-not $SkipToken) {
    Write-Head 'STEP 1 / 2 : validate credentials and obtain AccessToken'
    & $node (Join-Path $root 'src\01-token.js') $AppId $AppSecret
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '[FAIL] Step 1 failed. Step 2 cannot succeed with invalid credentials.' -ForegroundColor Red
        Write-Host '       Fix AppID / AppSecret and run again.' -ForegroundColor Red
        exit 1
    }
}

Write-Head "STEP 2 / 2 : gateway connection and intents permission (mode=$Mode)"
& $node (Join-Path $root 'src\02-gateway.js') $AppId $AppSecret $Mode
if ($LASTEXITCODE -ne 0) { $overall = 1 }

Write-Host ''
if ($overall -eq 0) {
    Write-Host 'Verification run finished. Read the CONCLUSION section above.' -ForegroundColor Green
}
else {
    Write-Host 'Verification run reported errors. Read the output above.' -ForegroundColor Red
}
exit $overall
