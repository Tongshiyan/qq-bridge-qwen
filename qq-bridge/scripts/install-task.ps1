# ============================================================
#  install-task.ps1 -- Windows auto-start helper for the DSH-QQ bridge.
#
#  Registers a Windows Scheduled Task that starts the bridge at user
#  logon, inside the user's own session, and restarts it if it exits
#  with an error.
#
#  Usage -- always call this through install-task.cmd:
#
#     scripts\install-task.cmd -Action status      state / last result / next run
#     scripts\install-task.cmd -Action install     register or update the task
#     scripts\install-task.cmd -Action uninstall   remove the task
#     scripts\install-task.cmd -Action start       start it now
#     scripts\install-task.cmd -Action stop        stop it
#     scripts\install-task.cmd -Action show        dry run, prints the definition
#
#     scripts\install-task.cmd status              (positional form also works)
#
#  Why the .cmd wrapper: this machine's PowerShell execution policy blocks
#  unsigned .ps1 files. The wrapper passes -ExecutionPolicy Bypass for that
#  one process only; it does not change any machine-wide policy.
#
#  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
#  .ps1 files using the system ANSI code page (GBK on a Chinese Windows), so
#  non-ASCII bytes here would be mis-decoded and can break parsing (classic
#  symptom: "The string is missing the terminator"). All Chinese
#  user-facing text lives in scripts\README.md instead.
#
#  Exit codes:
#     0  ok (status: the task exists)
#     1  unexpected error
#     2  bad usage / bad arguments
#     3  the task is not registered
#     4  required project files are missing
#     5  registration was refused (needs an elevated prompt)
# ============================================================

[CmdletBinding()]
param(
    # First positional argument, so `install-task.cmd status` works too.
    [Parameter(Position = 0)]
    [string]$Action = 'status',

    # Scheduled task name. Keep it ASCII and simple.
    [string]$TaskName = 'dsh-qq-bridge',

    # Project root. Defaults to the parent folder of this script.
    [string]$ProjectRoot,

    # Wait this many seconds after logon before starting (network settle).
    [int]$LogonDelaySeconds = 20
)

$ErrorActionPreference = 'Stop'
$script:TaskPath = '\'
$script:ValidActions = @('install', 'uninstall', 'status', 'start', 'stop', 'show', 'help')

# ------------------------------------------------------------------ output

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=' * 66) -ForegroundColor Cyan
    Write-Host ("  {0}" -f $Text) -ForegroundColor Cyan
    Write-Host ('=' * 66) -ForegroundColor Cyan
}

function Write-Ok   { param([string]$Text) Write-Host ("[ OK ] {0}" -f $Text) -ForegroundColor Green }
function Write-Info { param([string]$Text) Write-Host ("[INFO] {0}" -f $Text) -ForegroundColor Gray }
function Write-Warn { param([string]$Text) Write-Host ("[WARN] {0}" -f $Text) -ForegroundColor Yellow }
function Write-Fail { param([string]$Text) Write-Host ("[FAIL] {0}" -f $Text) -ForegroundColor Red }

function Write-Row {
    param([string]$Key, [string]$Value)
    Write-Host ('{0,-11}: {1}' -f $Key, $Value)
}

function Show-Usage {
    Write-Host ''
    Write-Host 'DSH-QQ bridge - Windows auto-start helper' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  install-task.cmd -Action status      show state, last result, next run'
    Write-Host '  install-task.cmd -Action install     register / update the scheduled task'
    Write-Host '  install-task.cmd -Action uninstall   remove the scheduled task'
    Write-Host '  install-task.cmd -Action start       start the bridge now'
    Write-Host '  install-task.cmd -Action stop        stop the bridge'
    Write-Host '  install-task.cmd -Action show        dry run (print the definition)'
    Write-Host ''
    Write-Host '  Options:'
    Write-Host '    -TaskName <name>          default: dsh-qq-bridge'
    Write-Host '    -ProjectRoot <path>       default: parent folder of this script'
    Write-Host '    -LogonDelaySeconds <n>    default: 20 (wait after logon)'
    Write-Host ''
    Write-Host '  Exit codes: 0 ok, 1 error, 2 bad usage, 3 not installed,'
    Write-Host '              4 missing project files, 5 needs elevation'
    Write-Host ''
}

# ------------------------------------------------------------------ helpers

# Windows localizes the LABELS that `schtasks /fo LIST /v` prints and the word
# it uses for the "running" state. Those strings cannot be written as literals
# here, because this file must stay ASCII-only (see the header): Windows
# PowerShell 5.1 would decode them with the ANSI code page (GBK) and could fail
# to parse the script. They are built at runtime from UTF-16 code points
# instead, which keeps the file pure ASCII and still matches a Chinese Windows.
function New-LocalizedText {
    param([int[]]$CodePoints)
    $builder = New-Object System.Text.StringBuilder
    foreach ($cp in $CodePoints) { [void]$builder.Append([char]$cp) }
    return $builder.ToString()
}

# English label is a literal; the second entry of each pair is the Chinese one.
#   0x4EFB 0x52A1 0x540D                                  task name
#   0x72B6 0x6001                                         status
#   0x8BA1 0x5212 0x4EFB 0x52A1 0x72B6 0x6001             scheduled task state
#   0x4E0A 0x6B21 0x8FD0 0x884C 0x65F6 0x95F4             last run time
#   0x4E0A 0x6B21 0x8FD0 0x884C 0x7ED3 0x679C             last result
#   0x4E0B 0x6B21 0x8FD0 0x884C 0x65F6 0x95F4             next run time
#   0x4EE5 0x7528 0x6237 0x8EAB 0x4EFD 0x8FD0 0x884C       run as user
#   0x767B 0x5F55 0x6A21 0x5F0F                           logon mode
#   0x8981 0x8FD0 0x884C 0x7684 0x4EFB 0x52A1             task to run
#   0x8D77 0x59CB 0x4E8E                                  start in
#   0x6B63 0x5728 0x8FD0 0x884C                           running
$script:LabelTaskName    = New-LocalizedText @(0x4EFB, 0x52A1, 0x540D)
$script:LabelStatus      = New-LocalizedText @(0x72B6, 0x6001)
$script:LabelTaskState   = New-LocalizedText @(0x8BA1, 0x5212, 0x4EFB, 0x52A1, 0x72B6, 0x6001)
$script:LabelLastRunTime = New-LocalizedText @(0x4E0A, 0x6B21, 0x8FD0, 0x884C, 0x65F6, 0x95F4)
$script:LabelLastResult  = New-LocalizedText @(0x4E0A, 0x6B21, 0x8FD0, 0x884C, 0x7ED3, 0x679C)
$script:LabelNextRunTime = New-LocalizedText @(0x4E0B, 0x6B21, 0x8FD0, 0x884C, 0x65F6, 0x95F4)
$script:LabelRunAs       = New-LocalizedText @(0x4EE5, 0x7528, 0x6237, 0x8EAB, 0x4EFD, 0x8FD0, 0x884C)
$script:LabelLogonMode   = New-LocalizedText @(0x767B, 0x5F55, 0x6A21, 0x5F0F)
$script:LabelTaskToRun   = New-LocalizedText @(0x8981, 0x8FD0, 0x884C, 0x7684, 0x4EFB, 0x52A1)
$script:LabelStartIn     = New-LocalizedText @(0x8D77, 0x59CB, 0x4E8E)
$script:WordRunning      = New-LocalizedText @(0x6B63, 0x5728, 0x8FD0, 0x884C)

function Get-FirstLine {
    param([string]$Text)
    if (-not $Text) { return '' }
    $line = ($Text -split "`r?`n")[0]
    return $line.Trim()
}

function Get-CurrentUserId {
    try {
        return [Security.Principal.WindowsIdentity]::GetCurrent().Name
    } catch {
        return ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME)
    }
}

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($id)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

# Windows PowerShell 5.1 is always present on Windows; pwsh may not be.
# The scheduled task must keep working long after this session ends, so
# prefer the inbox engine over whatever happens to be running right now.
function Get-WindowsPowerShellExe {
    $candidates = @()
    if ($PSHOME) { $candidates += (Join-Path $PSHOME 'powershell.exe') }
    if ($env:SystemRoot) {
        $candidates += (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return 'powershell.exe'
}

# The Task Scheduler WMI provider refuses non-elevated callers with
# 0x80041003 / 0x80070005. Detect that shape so we can print instructions
# instead of a raw CimException.
function Test-AccessDeniedError {
    param($ErrorRecord)
    if (-not $ErrorRecord) { return $false }
    $parts = @()
    if ($ErrorRecord.FullyQualifiedErrorId) { $parts += [string]$ErrorRecord.FullyQualifiedErrorId }
    if ($ErrorRecord.Exception -and $ErrorRecord.Exception.Message) { $parts += [string]$ErrorRecord.Exception.Message }
    $text = ($parts -join ' ')
    if ($text -match '0x80041003|0x80070005|PermissionDenied|Access is denied|access denied') {
        return $true
    }
    return $false
}

function Show-ElevationHelp {
    param([string]$Root, [string]$Name)
    Write-Host ''
    Write-Warn 'Windows refused to register or remove the scheduled task (access denied).'
    Write-Host '  Registering and deleting a scheduled task needs an elevated prompt.' -ForegroundColor Yellow
    Write-Host '  The bridge itself does NOT need elevation - only this call does' -ForegroundColor Yellow
    Write-Host '  (the task runs with RunLevel=Limited, so DSH stays unelevated).' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Do this:' -ForegroundColor Yellow
    Write-Host '    1. Press Win+X, choose "Terminal (Admin)" or "Windows PowerShell (Admin)"' -ForegroundColor Yellow
    Write-Host ('    2. cd /d "{0}"' -f $Root) -ForegroundColor Yellow
    Write-Host '    3. scripts\install-task.cmd -Action install' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Or: right-click scripts\install-task.cmd and choose "Run as administrator".' -ForegroundColor Yellow
    Write-Host ('  Task name: {0}   (folder: \)' -f $Name) -ForegroundColor DarkGray
}

# Wrap schtasks.exe: it goes straight to the Task Scheduler service and works
# with a plain user token, where the CIM cmdlets may be refused. Its stderr is
# swallowed (a missing task is a normal answer, not an error to display).
function Invoke-Schtasks {
    param([string[]]$Arguments)
    if (-not (Get-Command schtasks.exe -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ ExitCode = -1; Output = @(); Available = $false }
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & schtasks.exe @Arguments 2>$null
        $code = $LASTEXITCODE
        return [pscustomobject]@{ ExitCode = $code; Output = @($out); Available = $true }
    } catch {
        return [pscustomobject]@{ ExitCode = -1; Output = @(); Available = $true }
    } finally {
        $ErrorActionPreference = $previous
    }
}

# schtasks /fo LIST /v prints "Label: value" lines (labels are localized).
# Values longer than the console width may wrap; re-join those lines.
function ConvertFrom-SchtasksList {
    param([string[]]$Lines)
    $fields = [ordered]@{}
    $lastKey = $null
    foreach ($item in $Lines) {
        $line = [string]$item
        if ($line -match '^\s*$') { continue }
        if ($line -match '^([^:]{1,60}):\s?(.*)$') {
            $lastKey = $Matches[1].Trim()
            $fields[$lastKey] = $Matches[2].Trim()
        } elseif ($lastKey) {
            $fields[$lastKey] = (($fields[$lastKey] + ' ' + $line.Trim())).Trim()
        }
    }
    return $fields
}

# Exact match first, then substring, so "Status" never steals "Scheduled Task
# State" and Chinese labels still work.
function Get-FieldValue {
    param($Fields, [string[]]$Names)
    if (-not $Fields) { return '' }
    foreach ($name in $Names) {
        foreach ($key in $Fields.Keys) {
            if ([string]::Equals($key, $name, [StringComparison]::OrdinalIgnoreCase)) {
                return [string]$Fields[$key]
            }
        }
    }
    foreach ($name in $Names) {
        foreach ($key in $Fields.Keys) {
            if ($key -like ('*' + $name + '*')) { return [string]$Fields[$key] }
        }
    }
    return ''
}

function Format-Time {
    param($Value)
    if ($null -eq $Value) { return '(none)' }
    if ($Value -is [datetime]) {
        if ($Value.Year -le 1999) { return '(never)' }
        return $Value.ToString('yyyy-MM-dd HH:mm:ss')
    }
    $text = ([string]$Value).Trim()
    if ($text -eq '') { return '(none)' }
    if ($text -match '^N/A') { return 'N/A' }
    if ($text -match '^11/30/1999' -or $text -match '^1999-11-30') { return '(never)' }
    return $text
}

function Test-RunningState {
    param([string]$State)
    if (-not $State) { return $false }
    if ($State -like '*Running*') { return $true }
    if ($script:WordRunning -and $State -like ('*' + $script:WordRunning + '*')) { return $true }
    return $false
}

# schtasks prints Last Result as decimal or as 0x........; accept both.
function ConvertTo-TaskResultCode {
    param([string]$Text)
    $text = ([string]$Text).Trim()
    if ($text -eq '') { return $null }
    if ($text -match '^0x([0-9A-Fa-f]{1,8})$') {
        return [int64][Convert]::ToInt64($Matches[1], 16)
    }
    $value = [int64]0
    if ([int64]::TryParse($text, [ref]$value)) { return $value }
    return $null
}

function Get-UnsignedCode {
    param([int64]$Code)
    if ($Code -lt 0) { return [uint32]([int64]$Code + 4294967296) }
    return [uint32]$Code
}

function Format-TaskResultCode {
    param([int64]$Code)
    $unsigned = Get-UnsignedCode -Code $Code
    $key = '0x{0:X8}' -f $unsigned
    $known = @{
        '0x00000000' = 'success - the last run finished normally'
        '0x00000001' = 'incorrect function - generic task failure'
        '0x00041300' = 'ready to run'
        '0x00041301' = 'currently running'
        '0x00041302' = 'the task is disabled'
        '0x00041303' = 'has not run yet'
        '0x00041304' = 'no more runs scheduled'
        '0x00041305' = 'not scheduled - one or more triggers are missing'
        '0x00041306' = 'terminated by the user'
        '0x00041307' = 'no valid triggers'
        '0x80070002' = 'file not found - the task action could not start'
        '0x80070005' = 'access denied - the task was refused'
        '0x800710E0' = 'refused by the operator or administrator (already running?)'
        '0xC000013A' = 'terminated (Ctrl+C / process exit)'
    }
    $meaning = $null
    if ($known.ContainsKey($key)) { $meaning = $known[$key] }
    if ($meaning) {
        return ('{0} ({1}) - {2}' -f $key, $unsigned, $meaning)
    }
    if ($unsigned -eq 0) {
        return ('{0} ({1}) - success' -f $key, $unsigned)
    }
    return ('{0} ({1}) - unknown failure, check logs\service.log and logs\audit-*.jsonl' -f $key, $unsigned)
}

function Test-NeverRanCode {
    param([int64]$Code)
    return ($Code -in @(0x00041300, 0x00041303, 0x00041304, 0x00041305, 0x00041307))
}

# ------------------------------------------------------------------ the task

# The bridge is started by a hidden PowerShell that runs bin\node.cmd
# (the DSH-bundled Node runtime).
#
# Why the pipeline instead of a plain "*>> file" redirect:
#   - PowerShell 5.1 writes plain redirection as UTF-16LE, which makes the log
#     awkward to read; "-Encoding utf8" keeps it plain text.
#   - [Console]::OutputEncoding is raised to UTF-8 first, so the bridge's own
#     console output (it prints Chinese) is decoded correctly on the way in.
#   - Nothing is passed through a shell: the paths stay single arguments, so
#     a path can never be reinterpreted as a command.
# The exit code is forwarded, so a crash still triggers the restart policy.
function Get-BridgeInnerCommand {
    param([string]$Node, [string]$Main, [string]$ServiceLog)
    foreach ($path in @($Node, $Main, $ServiceLog)) {
        if ($path -match "'") {
            throw ('Path contains a single quote and cannot be quoted safely: {0}' -f $path)
        }
    }
    $template = 'try {{ [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }} catch {{ }}; ' +
                '& ''{0}'' ''{1}'' *>&1 | Out-File -LiteralPath ''{2}'' -Encoding utf8 -Append; ' +
                'exit $LASTEXITCODE'
    return ($template -f $Node, $Main, $ServiceLog)
}

function Get-BridgeArgument {
    param([string]$Inner)
    return ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "{0}"' -f $Inner)
}

# Crash self-heal, single instance, no time limit.
function New-BridgeSettings {
    $params = @{
        AllowStartIfOnBatteries    = $true
        DontStopIfGoingOnBatteries = $true
        DontStopOnIdleEnd          = $true
        StartWhenAvailable         = $true
        MultipleInstances          = 'IgnoreNew'
        ExecutionTimeLimit         = (New-TimeSpan -Seconds 0)
        RestartCount               = 999
        RestartInterval            = (New-TimeSpan -Minutes 1)
    }
    return New-ScheduledTaskSettingsSet @params
}

# ------------------------------------------------------------------ status

function New-StatusObject {
    return [pscustomobject]@{
        Installed   = $false
        Source      = ''
        Note        = ''
        State       = ''
        TaskState   = ''
        LastRunTime = ''
        LastResult  = ''
        NextRunTime = ''
        RunAs       = ''
        LogonMode   = ''
        TaskToRun   = ''
        StartIn     = ''
        Raw         = @()
    }
}

function Get-BridgeStatus {
    param([string]$Name)

    $status = New-StatusObject

    # 1) CIM: richest data (full command line, trigger details). Requires
    #    access to the Task Scheduler WMI provider, which non-elevated tokens
    #    may not have - so this is never the only path.
    try {
        $task = Get-ScheduledTask -TaskName $Name -TaskPath $script:TaskPath -ErrorAction Stop
        if ($task) {
            $status.Installed = $true
            $status.Source = 'cim'
            $status.State = [string]$task.State
            if ($task.Actions -and $task.Actions.Count -gt 0) {
                $a = $task.Actions[0]
                $status.TaskToRun = (([string]$a.Execute + ' ' + [string]$a.Arguments)).Trim()
                $status.StartIn = [string]$a.WorkingDirectory
            }
            if ($task.Principal) {
                $status.RunAs = [string]$task.Principal.UserId
                $status.LogonMode = [string]$task.Principal.LogonType
            }
            try {
                $info = Get-ScheduledTaskInfo -TaskName $Name -TaskPath $script:TaskPath -ErrorAction Stop
                if ($info) {
                    $status.LastRunTime = Format-Time $info.LastRunTime
                    $status.NextRunTime = Format-Time $info.NextRunTime
                    $status.LastResult = [string]$info.LastTaskResult
                }
            } catch {
                $status.Note = 'task info unavailable: ' + (Get-FirstLine $_.Exception.Message)
            }
            return $status
        }
    } catch {
        $status.Note = 'checked with schtasks.exe; the CIM query was refused (' + (Get-FirstLine $_.Exception.Message) + ')'
    }

    # 2) schtasks.exe: works with a plain user token. This is what status,
    #    start and stop rely on.
    $result = Invoke-Schtasks -Arguments @('/query', '/tn', ("\{0}" -f $Name), '/fo', 'LIST', '/v')
    if ($result.ExitCode -ne 0) {
        $result = Invoke-Schtasks -Arguments @('/query', '/tn', $Name, '/fo', 'LIST', '/v')
    }
    $fields = ConvertFrom-SchtasksList -Lines $result.Output
    $taskName = Get-FieldValue -Fields $fields -Names @('TaskName', $script:LabelTaskName)
    # Language-independent proof that the task exists: the ASCII task name
    # appears as a value somewhere in the (possibly localized) listing.
    $valueMatch = $false
    foreach ($value in $fields.Values) {
        if (([string]$value).Trim() -eq ("\{0}" -f $Name)) { $valueMatch = $true; break }
    }
    if ($result.ExitCode -eq 0 -and $fields.Count -gt 0 -and ($taskName -or $valueMatch)) {
        $status.Installed = $true
        $status.Source = 'schtasks'
        $status.Raw = @($result.Output)
        $status.State = Get-FieldValue -Fields $fields -Names @('Status', $script:LabelStatus)
        $status.TaskState = Get-FieldValue -Fields $fields -Names @('Scheduled Task State', $script:LabelTaskState)
        $status.LastRunTime = Get-FieldValue -Fields $fields -Names @('Last Run Time', $script:LabelLastRunTime)
        $status.LastResult = Get-FieldValue -Fields $fields -Names @('Last Result', $script:LabelLastResult)
        $status.NextRunTime = Get-FieldValue -Fields $fields -Names @('Next Run Time', $script:LabelNextRunTime)
        $status.RunAs = Get-FieldValue -Fields $fields -Names @('Run As User', $script:LabelRunAs)
        $status.LogonMode = Get-FieldValue -Fields $fields -Names @('Logon Mode', $script:LabelLogonMode)
        $status.TaskToRun = Get-FieldValue -Fields $fields -Names @('Task To Run', $script:LabelTaskToRun)
        $status.StartIn = Get-FieldValue -Fields $fields -Names @('Start In', $script:LabelStartIn)
        return $status
    }

    return $status
}

function Show-ServiceLogTail {
    param([string]$LogPath, [int]$Lines = 20)
    if (-not (Test-Path -LiteralPath $LogPath)) {
        Write-Info ('No service log yet: {0}' -f $LogPath)
        return
    }
    Write-Host ''
    Write-Host ('--- last {0} lines of {1} ---' -f $Lines, $LogPath) -ForegroundColor DarkGray
    Get-Content -LiteralPath $LogPath -Tail $Lines | ForEach-Object { Write-Host ('    {0}' -f $_) }
}

function Show-Status {
    param([string]$Name, [string]$Root)

    $serviceLog = Join-Path $Root 'logs\service.log'
    $status = Get-BridgeStatus -Name $Name

    Write-Head ("status: scheduled task '{0}'" -f $Name)

    if (-not $status.Installed) {
        Write-Host 'Installed  : no' -ForegroundColor Yellow
        if ($status.Note) { Write-Row 'Note' $status.Note }
        Write-Host ''
        Write-Host 'The task is not registered yet. To create it:' -ForegroundColor Yellow
        Write-Host '    scripts\install-task.cmd -Action install' -ForegroundColor Yellow
        Write-Host 'Registration usually needs an elevated prompt.' -ForegroundColor DarkGray
        exit 3
    }

    $code = ConvertTo-TaskResultCode -Text $status.LastResult
    $running = Test-RunningState -State $status.State

    Write-Row 'Installed' 'yes'
    Write-Row 'Source' $status.Source
    if ($status.State) { Write-Row 'State' $status.State }
    if ($status.TaskState) { Write-Row 'Task state' $status.TaskState }
    Write-Row 'Last run' (Format-Time $status.LastRunTime)
    if ($null -ne $code) { Write-Row 'Last result' (Format-TaskResultCode -Code $code) }
    else { Write-Row 'Last result' ([string]$status.LastResult) }
    Write-Row 'Next run' (Format-Time $status.NextRunTime)
    if ($status.RunAs) { Write-Row 'Run as' $status.RunAs }
    if ($status.LogonMode) { Write-Row 'Logon mode' $status.LogonMode }
    if ($status.TaskToRun) { Write-Row 'Task to run' $status.TaskToRun }
    if ($status.StartIn) { Write-Row 'Working dir' $status.StartIn }
    if ($status.Note) { Write-Row 'CIM note' $status.Note }

    Write-Host ''
    if ($running) {
        Write-Ok 'The bridge task is running.'
        Write-Host ('       Live audit log: {0}\audit-YYYY-MM-DD.jsonl' -f (Join-Path $Root 'logs')) -ForegroundColor DarkGray
        exit 0
    }

    if ($null -ne $code -and $code -eq 0) {
        Write-Ok 'The task is not running, but its last run exited with code 0.'
        Write-Host '       Start it with: scripts\install-task.cmd -Action start' -ForegroundColor DarkGray
        exit 0
    }

    Write-Warn 'The task is currently NOT running.'
    if ($null -ne $code -and (Test-NeverRanCode -Code $code)) {
        Write-Host '       Last result means "has not run yet".' -ForegroundColor Yellow
        Write-Host '       The logon trigger fires at the next logon; or start it now:' -ForegroundColor Yellow
        Write-Host '           scripts\install-task.cmd -Action start' -ForegroundColor Yellow
    } else {
        Write-Host '       The bridge probably failed to start. Its own output says why:' -ForegroundColor Yellow
        Show-ServiceLogTail -LogPath $serviceLog -Lines 20
        Write-Host ''
        Write-Host '       Then start it again:' -ForegroundColor Yellow
        Write-Host '           scripts\install-task.cmd -Action start' -ForegroundColor Yellow
    }

    if ($status.Raw -and $status.Raw.Count -gt 0) {
        Write-Host ''
        Write-Host '--- raw schtasks output ---' -ForegroundColor DarkGray
        foreach ($line in $status.Raw) { Write-Host ('    {0}' -f $line) -ForegroundColor DarkGray }
    }
    exit 0
}

# ------------------------------------------------------------------ install

function Invoke-Install {
    param([string]$Root, [string]$Name, [int]$DelaySeconds)

    Write-Head ("install: register scheduled task '{0}'" -f $Name)

    $node = Join-Path $Root 'bin\node.cmd'
    $main = Join-Path $Root 'src\main.js'
    $logDir = Join-Path $Root 'logs'
    $serviceLog = Join-Path $logDir 'service.log'

    $missing = @()
    if (-not (Test-Path -LiteralPath $node)) { $missing += $node }
    if (-not (Test-Path -LiteralPath $main)) { $missing += $main }
    if ($missing.Count -gt 0) {
        Write-Fail 'Required project files are missing:'
        foreach ($path in $missing) { Write-Host ('         {0}' -f $path) -ForegroundColor Red }
        Write-Host ('       Project root used: {0}' -f $Root) -ForegroundColor Yellow
        Write-Host '       Override it with: install-task.cmd -Action install -ProjectRoot <path>' -ForegroundColor Yellow
        exit 4
    }

    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        Write-Info ('Created log directory: {0}' -f $logDir)
    }

    # These two are the difference between "works" and "restart loop".
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'config\creds.json')) -and -not $env:QQ_APP_ID) {
        Write-Warn 'No config\creds.json and no QQ_APP_ID in this environment.'
        Write-Warn 'The bridge will exit immediately and the task will restart it in a loop.'
        Write-Warn 'Write config\creds.json first: a scheduled task does NOT inherit'
        Write-Warn 'environment variables that were only set in the current cmd window.'
    }
    if ($env:USERPROFILE -and -not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.dsh'))) {
        Write-Warn ('DSH config folder not found: {0}' -f (Join-Path $env:USERPROFILE '.dsh'))
        Write-Warn 'The bridge can start, but DSH tasks may fail with MISSING_CREDENTIAL.'
    }

    $me = Get-CurrentUserId
    $psExe = Get-WindowsPowerShellExe
    $inner = Get-BridgeInnerCommand -Node $node -Main $main -ServiceLog $serviceLog
    $argument = Get-BridgeArgument -Inner $inner
    $description = ('DSH-QQ bridge auto-start. Project: {0} (installed by scripts\install-task.ps1)' -f $Root)

    Write-Info ('Project root   : {0}' -f $Root)
    Write-Info ('Runs as        : {0}  (interactive, not elevated)' -f $me)
    Write-Info ('Execute        : {0}' -f $psExe)
    Write-Info ('Working dir    : {0}' -f $Root)
    Write-Info ('Logon delay    : {0}s' -f $DelaySeconds)

    $existing = Get-BridgeStatus -Name $Name
    if ($existing.Installed) {
        Write-Info 'An existing task was found; it will be updated in place (no duplicate).'
    }

    try {
        $actionParams = @{
            Execute          = $psExe
            Argument         = $argument
            WorkingDirectory = $Root
        }
        $action = New-ScheduledTaskAction @actionParams
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
        if ($DelaySeconds -gt 0) {
            try {
                $trigger.Delay = ('PT{0}S' -f $DelaySeconds)
            } catch {
                Write-Warn 'Could not set the logon delay; continuing without it.'
            }
        }
        $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
        $settings = New-BridgeSettings
        $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
    } catch {
        if (Test-AccessDeniedError -ErrorRecord $_) {
            Show-ElevationHelp -Root $Root -Name $Name
            exit 5
        }
        Write-Fail ('Could not build the task definition: {0}' -f (Get-FirstLine $_.Exception.Message))
        exit 1
    }

    $registered = $false
    try {
        Register-ScheduledTask -TaskName $Name -TaskPath $script:TaskPath -InputObject $task -Force -ErrorAction Stop | Out-Null
        $registered = $true
    } catch {
        $first = $_
        if (Test-AccessDeniedError -ErrorRecord $first) {
            Show-ElevationHelp -Root $Root -Name $Name
            exit 5
        }
        # Updating a task that is currently running can be refused; stop it
        # once and retry, so re-running install stays idempotent.
        $status = Get-BridgeStatus -Name $Name
        if (Test-RunningState -State $status.State) {
            Write-Warn ('Register failed: {0}' -f (Get-FirstLine $first.Exception.Message))
            Write-Info 'The task is running; stopping it and retrying the update...'
            Invoke-Schtasks -Arguments @('/end', '/tn', ("\{0}" -f $Name)) | Out-Null
            Start-Sleep -Seconds 2
            try {
                Register-ScheduledTask -TaskName $Name -TaskPath $script:TaskPath -InputObject $task -Force -ErrorAction Stop | Out-Null
                $registered = $true
            } catch {
                if (Test-AccessDeniedError -ErrorRecord $_) {
                    Show-ElevationHelp -Root $Root -Name $Name
                    exit 5
                }
                Write-Fail ('Register-ScheduledTask failed: {0}' -f (Get-FirstLine $_.Exception.Message))
                exit 1
            }
        } else {
            Write-Fail ('Register-ScheduledTask failed: {0}' -f (Get-FirstLine $first.Exception.Message))
            exit 1
        }
    }

    if (-not $registered) {
        Write-Fail 'Registration did not complete.'
        exit 1
    }

    Write-Host ''
    Write-Ok ('Task registered: \{0}' -f $Name)
    Write-Host ('       Trigger    : at logon of {0}, {1}s delay' -f $me, $DelaySeconds)
    Write-Host '       Principal  : interactive token, RunLevel=Limited (no admin)'
    Write-Host ('       WorkingDir : {0}' -f $Root)
    Write-Host '       Restart    : up to 999 times, every 1 minute, on failure'
    Write-Host '       Instances  : IgnoreNew (a second copy is never started)'
    Write-Host '       Time limit : none'
    if (-not (Test-IsAdmin)) {
        Write-Info 'Note: this prompt is not elevated, yet registration succeeded.'
    }
    Write-Host ''
    Write-Host 'Next steps:' -ForegroundColor Cyan
    Write-Host '    scripts\install-task.cmd -Action start     (start it now)'
    Write-Host '    scripts\install-task.cmd -Action status    (confirm it runs)'
    Write-Host ('    type {0}' -f $serviceLog)
    Write-Host '    type logs\audit-YYYY-MM-DD.jsonl           (one JSON object per line)'
}

# ------------------------------------------------------------------ show

function Invoke-Show {
    param([string]$Root, [string]$Name, [int]$DelaySeconds)

    $node = Join-Path $Root 'bin\node.cmd'
    $main = Join-Path $Root 'src\main.js'
    $serviceLog = Join-Path $Root 'logs\service.log'

    Write-Head ("show: definition that would be registered for '{0}'" -f $Name)
    Write-Host 'This is a dry run. Nothing is created, changed or started.' -ForegroundColor Green

    Write-Row 'Task name' $Name
    Write-Row 'Task folder' '\'
    Write-Row 'Project root' $Root
    Write-Row 'Node wrapper' $node
    Write-Row 'Main script' $main
    Write-Host ''
    Write-Host 'Trigger:' -ForegroundColor Cyan
    Write-Row '  Type' ('AtLogOn (user {0})' -f (Get-CurrentUserId))
    Write-Row '  Delay' ('{0}s after logon' -f $DelaySeconds)
    Write-Host 'Principal:' -ForegroundColor Cyan
    Write-Row '  User' (Get-CurrentUserId)
    Write-Row '  Logon type' 'Interactive (runs in this user''s session, needs the user logged on)'
    Write-Row '  Run level' 'Limited (least privilege; no UAC prompt)'
    Write-Host 'Settings:' -ForegroundColor Cyan
    Write-Row '  Instances' 'IgnoreNew (never start a second copy)'
    Write-Row '  Restart' 'RestartCount=999, RestartInterval=PT1M'
    Write-Row '  Time limit' 'PT0S (unlimited - the bridge is a long-running service)'
    Write-Row '  Batteries' 'start allowed, never stopped when switching to battery'
    Write-Row '  Missed runs' 'StartWhenAvailable=true'
    Write-Host ''
    Write-Host 'Action (exact command line):' -ForegroundColor Cyan
    try {
        $inner = Get-BridgeInnerCommand -Node $node -Main $main -ServiceLog $serviceLog
    } catch {
        Write-Fail (Get-FirstLine $_.Exception.Message)
        exit 1
    }
    Write-Host ('  {0}' -f (Get-WindowsPowerShellExe))
    Write-Host ('  {0}' -f (Get-BridgeArgument -Inner $inner))
    Write-Host ('  WorkingDirectory: {0}' -f $Root)
    Write-Host ''
    Write-Host 'Breakdown of the command above:' -ForegroundColor Cyan
    Write-Host '  powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden'
    Write-Host '    -> hides the console window (no flashing window at logon)'
    Write-Host ('    -> runs: {0} {1}' -f $node, $main)
    Write-Host ('    -> appends stdout+stderr to {0} as UTF-8' -f $serviceLog)
    Write-Host '    -> exit code is forwarded, so a crash triggers the restart policy'
    Write-Host ''

    try {
        $actionParams = @{
            Execute          = (Get-WindowsPowerShellExe)
            Argument         = (Get-BridgeArgument -Inner $inner)
            WorkingDirectory = $Root
        }
        $action = New-ScheduledTaskAction @actionParams
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User (Get-CurrentUserId)
        $principal = New-ScheduledTaskPrincipal -UserId (Get-CurrentUserId) -LogonType Interactive -RunLevel Limited
        $settings = New-BridgeSettings
        $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
        Write-Host 'Full task XML that Register-ScheduledTask would receive:' -ForegroundColor Cyan
        Write-Host (Export-ScheduledTask -InputObject $task)
    } catch {
        Write-Host 'Could not build/export the task definition in this session:' -ForegroundColor DarkGray
        Write-Host ('  {0}' -f (Get-FirstLine $_.Exception.Message)) -ForegroundColor DarkGray
        Write-Host 'The Task Scheduler WMI provider refuses non-elevated callers' -ForegroundColor DarkGray
        Write-Host '(0x80041003). This does not affect status/start/stop, which use' -ForegroundColor DarkGray
        Write-Host 'schtasks.exe, and it does not affect the command line printed above.' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Info 'Dry run only - no scheduled task was registered.'
    exit 0
}

# ------------------------------------------------------------------ start

function Invoke-Start {
    param([string]$Name, [string]$Root)

    Write-Head ("start: scheduled task '{0}'" -f $Name)
    $status = Get-BridgeStatus -Name $Name
    if (-not $status.Installed) {
        Write-Fail ('Task ''{0}'' is not installed.' -f $Name)
        Write-Host '       Create it first: scripts\install-task.cmd -Action install' -ForegroundColor Yellow
        exit 3
    }
    if (Test-RunningState -State $status.State) {
        Write-Ok 'Already running; nothing to do.'
        exit 0
    }

    $result = Invoke-Schtasks -Arguments @('/run', '/tn', ("\{0}" -f $Name))
    if ($result.ExitCode -ne 0) {
        try {
            Start-ScheduledTask -TaskName $Name -TaskPath $script:TaskPath -ErrorAction Stop
        } catch {
            if (Test-AccessDeniedError -ErrorRecord $_) {
                Show-ElevationHelp -Root $Root -Name $Name
                exit 5
            }
            Write-Fail ('Could not start the task: {0}' -f (Get-FirstLine $_.Exception.Message))
            exit 1
        }
    }
    Write-Info 'Start requested; waiting 3 seconds and re-checking...'
    Start-Sleep -Seconds 3

    $after = Get-BridgeStatus -Name $Name
    $code = ConvertTo-TaskResultCode -Text $after.LastResult
    if ($after.State) { Write-Row 'State' $after.State }
    if ($null -ne $code) { Write-Row 'Last result' (Format-TaskResultCode -Code $code) }

    if (Test-RunningState -State $after.State) {
        Write-Host ''
        Write-Ok 'The bridge task is running.'
        exit 0
    }

    Write-Host ''
    Write-Warn 'The task is not running 3 seconds after start - it probably failed.'
    Show-ServiceLogTail -LogPath (Join-Path $Root 'logs\service.log') -Lines 20
    exit 1
}

# ------------------------------------------------------------------ stop

function Invoke-Stop {
    param([string]$Name, [string]$Root)

    Write-Head ("stop: scheduled task '{0}'" -f $Name)
    $status = Get-BridgeStatus -Name $Name
    if (-not $status.Installed) {
        Write-Info ('Task ''{0}'' is not installed; nothing to stop.' -f $Name)
        exit 3
    }
    if (-not (Test-RunningState -State $status.State)) {
        Write-Info ('Task ''{0}'' is not running.' -f $Name)
        exit 0
    }

    $result = Invoke-Schtasks -Arguments @('/end', '/tn', ("\{0}" -f $Name))
    if ($result.ExitCode -ne 0) {
        try {
            Stop-ScheduledTask -TaskName $Name -TaskPath $script:TaskPath -ErrorAction Stop
        } catch {
            if (Test-AccessDeniedError -ErrorRecord $_) {
                Show-ElevationHelp -Root $Root -Name $Name
                exit 5
            }
            Write-Fail ('Could not stop the task: {0}' -f (Get-FirstLine $_.Exception.Message))
            exit 1
        }
    }

    Start-Sleep -Seconds 2
    $after = Get-BridgeStatus -Name $Name
    if (Test-RunningState -State $after.State) {
        Write-Warn 'The task still reports "Running". Try again, or end it from Task Scheduler.'
        exit 1
    }
    Write-Ok 'The task was stopped.'
    Write-Host '       The logon trigger stays registered; it will start again at the next logon.' -ForegroundColor DarkGray
    Write-Host '       Task Scheduler ends the task process. If a child node process' -ForegroundColor DarkGray
    Write-Host '       survives it, check with: tasklist | findstr /i "node cmd"' -ForegroundColor DarkGray
    exit 0
}

# ------------------------------------------------------------------ uninstall

function Invoke-Uninstall {
    param([string]$Root, [string]$Name)

    Write-Head ("uninstall: remove scheduled task '{0}'" -f $Name)
    $status = Get-BridgeStatus -Name $Name
    if (-not $status.Installed) {
        Write-Info ('Task ''{0}'' is not registered; nothing to remove.' -f $Name)
        exit 0
    }

    if (Test-RunningState -State $status.State) {
        Write-Info 'Stopping the running task first...'
        Invoke-Schtasks -Arguments @('/end', '/tn', ("\{0}" -f $Name)) | Out-Null
        Start-Sleep -Seconds 2
    }

    $removed = $false
    $result = Invoke-Schtasks -Arguments @('/delete', '/tn', ("\{0}" -f $Name), '/f')
    if ($result.ExitCode -eq 0) {
        $removed = $true
    } else {
        try {
            Unregister-ScheduledTask -TaskName $Name -TaskPath $script:TaskPath -Confirm:$false -ErrorAction Stop
            $removed = $true
        } catch {
            if (Test-AccessDeniedError -ErrorRecord $_) {
                Show-ElevationHelp -Root $Root -Name $Name
                exit 5
            }
            Write-Fail ('Could not remove the task: {0}' -f (Get-FirstLine $_.Exception.Message))
            exit 1
        }
    }

    if ($removed) {
        Write-Ok ('Task removed: \{0}' -f $Name)
    }
    Write-Host ''
    Write-Host 'Files were NOT touched. To remove every trace of the bridge itself:' -ForegroundColor Cyan
    Write-Host ('    rmdir /s /q "{0}\logs"      (audit + service logs)' -f $Root)
    Write-Host ('    rmdir /s /q "{0}\state"     (sessions, pending confirmations)' -f $Root)
    Write-Host ('    rmdir /s /q "{0}\workspace" (only if you do not need its files)' -f $Root)
    Write-Host ('    del "{0}\config\creds.json"' -f $Root)
    Write-Host 'Confirm with: schtasks /query /tn "\dsh-qq-bridge"   (should say not found)' -ForegroundColor DarkGray
    exit 0
}

# ------------------------------------------------------------------ main

if ($Action) { $Action = $Action.Trim().ToLower() } else { $Action = 'status' }

if ($Action -eq 'help' -or $Action -eq '-h' -or $Action -eq '/?') {
    Show-Usage
    exit 0
}

if ($script:ValidActions -notcontains $Action) {
    Write-Fail ('Unknown action: {0}' -f $Action)
    Show-Usage
    exit 2
}

if (-not ($TaskName -match '^[A-Za-z0-9._-]{1,60}$')) {
    Write-Fail ('Invalid task name: {0}' -f $TaskName)
    Write-Host '       Use only letters, digits, dot, underscore and dash.' -ForegroundColor Yellow
    exit 2
}

if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if (-not $ProjectRoot) {
    Write-Fail 'Could not determine the project root. Pass -ProjectRoot <path>.'
    exit 4
}
try {
    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
} catch {
    Write-Fail ('Project root not found: {0}' -f $ProjectRoot)
    exit 4
}
$ProjectRoot = $ProjectRoot.TrimEnd('\')

switch ($Action) {
    'install'   { Invoke-Install -Root $ProjectRoot -Name $TaskName -DelaySeconds $LogonDelaySeconds }
    'uninstall' { Invoke-Uninstall -Root $ProjectRoot -Name $TaskName }
    'status'    { Show-Status -Name $TaskName -Root $ProjectRoot }
    'start'     { Invoke-Start -Name $TaskName -Root $ProjectRoot }
    'stop'      { Invoke-Stop -Name $TaskName -Root $ProjectRoot }
    'show'      { Invoke-Show -Root $ProjectRoot -Name $TaskName -DelaySeconds $LogonDelaySeconds }
}
