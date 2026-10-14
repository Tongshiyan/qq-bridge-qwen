# ============================================================
#  Qwen3.8-27B 控制台  (PowerShell + WinForms)
#  由 Qwen控制台.exe 启动；也可直接:
#     powershell -ExecutionPolicy Bypass -File QwenControlPanel.ps1
#     powershell -ExecutionPolicy Bypass -File QwenControlPanel.ps1 -SelfTest
#
#  NOTE: 本文件必须以「带 BOM 的 UTF-8」保存，否则 PowerShell 5.1
#        会把中文当 GBK 读，界面乱码甚至解析失败。
# ============================================================
param([switch]$SelfTest)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }

# ---------------------------------------------------------------- 常量
$QwenDir    = 'QWEN_DIR_PLACEHOLDER'
$BridgeDir  = 'BRIDGE_DIR_PLACEHOLDER'
$Server     = 'user@your-server-ip'
$TunnelCmd  = Join-Path $QwenDir 'start-tunnel.cmd'
$AutoScript = Join-Path $QwenDir 'disable-autostart.ps1'
$BridgeLock = Join-Path $BridgeDir 'state\bridge.lock'
$BridgeLog  = Join-Path $BridgeDir 'logs\autostart.log'
$StartAll   = Join-Path $BridgeDir 'scripts\start-all.cmd'
$Electron   = 'DSH_DIR_PLACEHOLDER\DeepSeek Harness.exe'

# ---------------------------------------------------------------- 工具
function New-CimList([string]$filter) {
    @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue)
}

function Get-Keeper {
    # 隧道守护有两种启动方式，都必须认得出来，否则“停止”杀不掉守护、隧道会被立刻拉起：
    #   1) -File ...\tunnel.ps1（旧方式）
    #   2) -EncodedCommand（本控制台 Start-TunnelAction 所用的方式，命令行里没有 tunnel.ps1 字样）
    # 所以除了命令行匹配，还要按「谁是我们隧道 ssh 进程的父进程」来认。
    $parents = @{}
    foreach ($s in @(Get-TunnelSsh)) { $parents[[int]$s.ParentProcessId] = $true }
    New-CimList "Name='powershell.exe'" | Where-Object {
        $_.ProcessId -ne $PID -and (
            $parents.ContainsKey([int]$_.ProcessId) -or
            ($_.CommandLine -like '*-File*' -and $_.CommandLine -like '*tunnel.ps1*' -and $_.CommandLine -notlike '*-Command*')
        ) }
}

function Get-TunnelSsh {
    New-CimList "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*-L 8000*' }
}

function Get-BridgePid {
    if (-not (Test-Path -LiteralPath $BridgeLock)) { return 0 }
    try { return [int]((Get-Content -LiteralPath $BridgeLock -Raw) | ConvertFrom-Json).pid } catch { return 0 }
}

function Test-Port8000 {
    [bool](Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)
}

function Invoke-Ssh([string]$remote, [int]$timeoutMs = 90000) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = 'ssh.exe'
    $psi.Arguments              = "-o BatchMode=yes -o ConnectTimeout=8 $Server $remote"
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.CreateNoWindow         = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill() } catch { }; return '(超时)' }
        return ($p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()).Trim()
    } catch { return ('(失败: ' + $_.Exception.Message + ')') }
}

# ---------------------------------------------------------------- 状态
function Get-LocalState {
    $keeper = @(Get-Keeper); $ssh = @(Get-TunnelSsh); $port = Test-Port8000
    $bpid = Get-BridgePid
    $bAlive = [bool]($bpid -and (Get-Process -Id $bpid -ErrorAction SilentlyContinue))
    $task = Get-ScheduledTask -TaskName 'qwen-stack-autostart' -ErrorAction SilentlyContinue
    $startup = @()
    try {
        $sf = [Environment]::GetFolderPath('Startup')
        $startup = @(Get-ChildItem -LiteralPath $sf -File -Force -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -like '*QQ-Robot*' -or $_.Name -like '*tunnel*' })
    } catch { }
    [pscustomobject]@{
        TunnelUp   = ($ssh.Count -gt 0)
        TunnelPid  = if ($ssh.Count) { ($ssh | ForEach-Object { $_.ProcessId }) -join ',' } else { '' }
        KeeperUp   = ($keeper.Count -gt 0)
        PortUp     = $port
        BridgeUp   = $bAlive
        BridgePid  = $bpid
        TaskState  = if ($task) { [string]$task.State } else { '未安装' }
        StartupOn  = ($startup.Count -gt 0)
    }
}

function Refresh-Local {
    $s = Get-LocalState
    if ($s.TunnelUp -and $s.PortUp) {
        $lblTunnel.Text = "● 隧道运行中  (ssh PID $($s.TunnelPid)，本地 8000 已监听)"
        $lblTunnel.ForeColor = [System.Drawing.Color]::FromArgb(30,125,50)
    } elseif ($s.KeeperUp) {
        $lblTunnel.Text = '● 守护进程在跑，但隧道未连通（会自动重试）'
        $lblTunnel.ForeColor = [System.Drawing.Color]::FromArgb(200,130,20)
    } else {
        $lblTunnel.Text = '○ 隧道未运行'
        $lblTunnel.ForeColor = [System.Drawing.Color]::FromArgb(150,40,40)
    }
    $lblTunnelSub.Text = "守护进程: $(if ($s.KeeperUp) {'运行中'} else {'未运行'})    端口 8000: $(if ($s.PortUp) {'监听中'} else {'未监听'})"

    if ($s.BridgeUp) {
        $lblBridge.Text = "● QQ 机器人运行中  (PID $($s.BridgePid))"
        $lblBridge.ForeColor = [System.Drawing.Color]::FromArgb(30,125,50)
    } else {
        $lblBridge.Text = '○ QQ 机器人未运行'
        $lblBridge.ForeColor = [System.Drawing.Color]::FromArgb(150,40,40)
    }

    $autoOn = ($s.TaskState -eq 'Ready' -or $s.TaskState -eq 'Running') -or $s.StartupOn
    if ($autoOn) {
        $lblAuto.Text = "● 开机自启：已启用  (任务 $($s.TaskState)$(if ($s.StartupOn) {'，启动文件夹有项'} else {''}))"
        $lblAuto.ForeColor = [System.Drawing.Color]::FromArgb(30,125,50)
    } else {
        $lblAuto.Text = '○ 开机自启：已关闭（任务 Disabled / 启动文件夹无项）'
        $lblAuto.ForeColor = [System.Drawing.Color]::FromArgb(110,110,110)
    }
    return $s
}

function Refresh-Server {
    $bSrvRefresh.Enabled = $false
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    try {
        $out = Invoke-Ssh 'bash /home/ac/qwen3.8-agent/bin/q38 status' 60000
        # 老机是 systemd 版 q38（输出 "active (running)"），新机是无 systemd 版（输出 "服务：运行中"）
        $active = if ($out -match '服务：运行中|active \(running\)') { '运行中' } else { '未运行' }
        $http   = if ($out -match 'HTTP 200') { 'HTTP 200' } else { '无响应' }
        $gpu    = ($out -split "`n" | Where-Object { $_ -match '^\s*\d+,\s*\d+ MiB' } |
                   ForEach-Object { ($_.Trim() -replace '\s+', ' ') }) -join '  |  '
        $lblSrv.Text  = "● 模型服务：$active    接口：$http"
        $lblSrv.ForeColor = if ($active -eq '运行中') { [System.Drawing.Color]::FromArgb(30,125,50) } else { [System.Drawing.Color]::FromArgb(150,40,40) }
        $lblSrvSub.Text = if ($gpu) { "GPU: $gpu" } else { '（未取到 GPU 信息）' }
    } finally {
        $bSrvRefresh.Enabled = $true
        $form.Cursor = [System.Windows.Forms.Cursors]::Default
    }
}

$script:logBox = $null
function Write-Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    if ($script:logBox) {
        $script:logBox.AppendText($line + "`r`n")
        $script:logBox.SelectionStart = $script:logBox.TextLength
        $script:logBox.ScrollToCaret()
    }
    Write-Host $line
}

# ---------------------------------------------------------------- 动作
# 隧道守护：隐藏窗口启动（无黑框），输出重定向到 logs\tunnel.log，仍可随时查看
function Start-TunnelAction {
    if ((Get-Keeper).Count -gt 0 -or (Get-TunnelSsh).Count -gt 0) {
        Write-Log '隧道已在运行，未重复启动。'
        Refresh-Local | Out-Null
        return
    }
    $ps1 = Join-Path $QwenDir 'tunnel.ps1'
    if (-not (Test-Path -LiteralPath $ps1)) { Write-Log "找不到 $ps1"; return }
    $logDir = Join-Path $QwenDir 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $tlog = Join-Path $logDir 'tunnel.log'
    # 用 -EncodedCommand 传参，彻底避开引号/空格转义问题
    $inner = "& '" + $ps1 + "' -Server '" + $script:Server + "' *> '" + $tlog + "'"
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))
    try {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', $enc `
            -WindowStyle Hidden
        Write-Log "已启动隧道守护（隐藏窗口）。日志：$tlog"
    } catch {
        Write-Log ('启动隧道失败: ' + $_.Exception.Message)
    }
    Start-Sleep -Milliseconds 1200
    Refresh-Local | Out-Null
}

function Stop-TunnelAction {
    $k = @(Get-Keeper); $s = @(Get-TunnelSsh)
    foreach ($p in $k) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Log "已结束守护进程 PID $($p.ProcessId)" } catch { } }
    foreach ($p in $s) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Log "已结束隧道进程 PID $($p.ProcessId)" } catch { } }
    if ($k.Count -eq 0 -and $s.Count -eq 0) { Write-Log '隧道本来就没有在运行。' }
    Start-Sleep -Milliseconds 700
    Refresh-Local | Out-Null
}

function Start-BridgeAction {
    if ((Get-BridgePid) -and (Get-Process -Id (Get-BridgePid) -ErrorAction SilentlyContinue)) {
        Write-Log 'QQ 机器人已在运行，未重复启动。'; Refresh-Local | Out-Null; return
    }
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        Start-Process -FilePath $Electron -ArgumentList 'src\main.js' -WorkingDirectory $BridgeDir -WindowStyle Hidden
        Write-Log '已启动 QQ 机器人（隐藏窗口）。'
    } catch { Write-Log ('启动 QQ 机器人失败: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 3
    Refresh-Local | Out-Null
}

function Stop-BridgeAction {
    if ((Get-Keeper).Count -gt 0) { Write-Log '提示：隧道守护仍在运行（QQ 机器人与隧道是分开的）。' }
    $bpid = Get-BridgePid
    if ($bpid -and (Get-Process -Id $bpid -ErrorAction SilentlyContinue)) {
        try { Stop-Process -Id $bpid -Force -ErrorAction Stop; Write-Log "已结束 QQ 机器人 PID $bpid" } catch { Write-Log ('结束失败: ' + $_.Exception.Message) }
    } else { Write-Log 'QQ 机器人本来就没有在运行。' }
    Start-Sleep -Milliseconds 700
    Refresh-Local | Out-Null
}

function Invoke-AutoScript([string]$arg, [string]$what) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$AutoScript`" $arg"
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit(30000) | Out-Null
    Write-Log "$what 完成。"
    Refresh-Local | Out-Null
}

function Invoke-Server([string]$action, [string]$what) {
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    try {
        Write-Log "$what ...（已发送命令）"
        $out = Invoke-Ssh "bash /home/ac/qwen3.8-agent/bin/q38 $action" 120000
        $tail = ($out -split "`n" | Select-Object -Last 3) -join ' / '
        Write-Log "$what 返回：$tail"
    } finally { $form.Cursor = [System.Windows.Forms.Cursors]::Default }
    Start-Sleep -Seconds 2
    Refresh-Server
}

# ---------------------------------------------------------------- 构建界面
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Qwen3.8-27B 控制台'
$form.ClientSize = New-Object System.Drawing.Size(648, 662)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.BackColor = [System.Drawing.Color]::FromArgb(248,250,252)
# 窗口/任务栏图标（与 exe 图标同一个 .ico）
$icoPath = Join-Path $QwenDir 'qwen.ico'
if (Test-Path -LiteralPath $icoPath) {
    try { $form.Icon = New-Object System.Drawing.Icon($icoPath) } catch { }
}

$cnFont = $form.Font
function New-Label($text, $x, $y, $w, $h, $size, $bold) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, $h); $l.Font = $cnFont
    if ($bold) { $l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', $size, [System.Drawing.FontStyle]::Bold) }
    else { $l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', $size) }
    $form.Controls.Add($l); return $l
}
function New-Group($text, $x, $y, $w, $h) {
    $g = New-Object System.Windows.Forms.GroupBox
    $g.Text = $text; $g.Location = New-Object System.Drawing.Point($x, $y)
    $g.Size = New-Object System.Drawing.Size($w, $h); $g.Font = $cnFont
    $form.Controls.Add($g); return $g
}

$script:tip = New-Object System.Windows.Forms.ToolTip
$script:tip.AutoPopDelay = 12000

New-Label 'Qwen3.8-27B 控制台' 16 8 600 26 15 $true | Out-Null
New-Label '本地组件开关 · 服务器服务开关 · 实时状态' 18 38 300 18 9 $false | Out-Null

# —— 目标服务器选择（二卡机 / 四卡机共用一个控制台）
$script:Hosts = @(
    @{ Host = 'user@your-server-ip'; Name = 'your-server-ip · 二卡机（现役）' },
    @{ Host = 'user@your-old-server-ip'; Name = 'your-old-server-ip · 四卡机（备用）' }
)
New-Label '服务器：' 334 38 56 18 9 $false | Out-Null
$cbHost = New-Object System.Windows.Forms.ComboBox
$cbHost.Location = New-Object System.Drawing.Point(392, 34)
$cbHost.Size = New-Object System.Drawing.Size(240, 24)
$cbHost.DropDownStyle = 'DropDownList'
$cbHost.Font = $cnFont
foreach ($h in $script:Hosts) { [void]$cbHost.Items.Add($h.Name) }
$cbHost.SelectedIndex = 0
$form.Controls.Add($cbHost)

# —— 隧道
$g1 = New-Group ('本地 · SSH 隧道（本地 8000 → ' + ($Server -replace '^ac@','') + ' 的 8000）') 14 60 620 100
$lblTunnel = New-Object System.Windows.Forms.Label
$lblTunnel.Location = New-Object System.Drawing.Point(14,26); $lblTunnel.Size = New-Object System.Drawing.Size(450,20)
$lblTunnel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold)
$g1.Controls.Add($lblTunnel)
$lblTunnelSub = New-Object System.Windows.Forms.Label
$lblTunnelSub.Location = New-Object System.Drawing.Point(14,50); $lblTunnelSub.Size = New-Object System.Drawing.Size(450,20)
$lblTunnelSub.ForeColor = [System.Drawing.Color]::FromArgb(100,110,120)
$g1.Controls.Add($lblTunnelSub)
$bTunOn = New-Object System.Windows.Forms.Button
$bTunOn.Text='启动'; $bTunOn.Location=New-Object System.Drawing.Point(482,22); $bTunOn.Size=New-Object System.Drawing.Size(60,28)
$g1.Controls.Add($bTunOn)
$script:tip.SetToolTip($bTunOn, '隐藏窗口后台启动隧道守护（不会弹黑框）；日志写到 logs\tunnel.log')
$bTunOff = New-Object System.Windows.Forms.Button
$bTunOff.Text='停止'; $bTunOff.Location=New-Object System.Drawing.Point(548,22); $bTunOff.Size=New-Object System.Drawing.Size(60,28)
$g1.Controls.Add($bTunOff)

# —— QQ 机器人
$g2 = New-Group '本地 · QQ 机器人（桥接）' 14 168 620 82
$lblBridge = New-Object System.Windows.Forms.Label
$lblBridge.Location = New-Object System.Drawing.Point(14,26); $lblBridge.Size = New-Object System.Drawing.Size(450,20)
$lblBridge.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold)
$g2.Controls.Add($lblBridge)
$bBrOn = New-Object System.Windows.Forms.Button
$bBrOn.Text='启动'; $bBrOn.Location=New-Object System.Drawing.Point(482,22); $bBrOn.Size=New-Object System.Drawing.Size(60,28)
$g2.Controls.Add($bBrOn)
$bBrOff = New-Object System.Windows.Forms.Button
$bBrOff.Text='停止'; $bBrOff.Location=New-Object System.Drawing.Point(548,22); $bBrOff.Size=New-Object System.Drawing.Size(60,28)
$g2.Controls.Add($bBrOff)
$lblBridgeSub = New-Object System.Windows.Forms.Label
$lblBridgeSub.Text='机器人通过隧道访问模型；单独停止机器人不会影响隧道'
$lblBridgeSub.Location = New-Object System.Drawing.Point(14,50); $lblBridgeSub.Size = New-Object System.Drawing.Size(450,20)
$lblBridgeSub.ForeColor = [System.Drawing.Color]::FromArgb(100,110,120)
$g2.Controls.Add($lblBridgeSub)

# —— 自启
$g3 = New-Group '本地 · 开机自启' 14 258 620 82
$lblAuto = New-Object System.Windows.Forms.Label
$lblAuto.Location = New-Object System.Drawing.Point(14,26); $lblAuto.Size = New-Object System.Drawing.Size(450,20)
$lblAuto.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold)
$g3.Controls.Add($lblAuto)
$bAutoOn = New-Object System.Windows.Forms.Button
$bAutoOn.Text='启用'; $bAutoOn.Location=New-Object System.Drawing.Point(482,22); $bAutoOn.Size=New-Object System.Drawing.Size(60,28)
$g3.Controls.Add($bAutoOn)
$bAutoOff = New-Object System.Windows.Forms.Button
$bAutoOff.Text='关闭'; $bAutoOff.Location=New-Object System.Drawing.Point(548,22); $bAutoOff.Size=New-Object System.Drawing.Size(60,28)
$g3.Controls.Add($bAutoOff)
$lblAutoSub = New-Object System.Windows.Forms.Label
$lblAutoSub.Text='控制登录时是否自动拉起隧道 / 机器人（可随时切换）'
$lblAutoSub.Location = New-Object System.Drawing.Point(14,50); $lblAutoSub.Size = New-Object System.Drawing.Size(450,20)
$lblAutoSub.ForeColor = [System.Drawing.Color]::FromArgb(100,110,120)
$g3.Controls.Add($lblAutoSub)

# —— 服务器
$g4 = New-Group '服务器 · 模型服务（2× RTX 3090 / Qwen3.8-27B）' 14 348 620 116
$lblSrv = New-Object System.Windows.Forms.Label
$lblSrv.Location = New-Object System.Drawing.Point(14,24); $lblSrv.Size = New-Object System.Drawing.Size(450,20)
$lblSrv.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold)
$g4.Controls.Add($lblSrv)
$lblSrvSub = New-Object System.Windows.Forms.Label
$lblSrvSub.Location = New-Object System.Drawing.Point(14,48); $lblSrvSub.Size = New-Object System.Drawing.Size(586,20)
$lblSrvSub.ForeColor = [System.Drawing.Color]::FromArgb(100,110,120)
$g4.Controls.Add($lblSrvSub)
$bSrvStart = New-Object System.Windows.Forms.Button
$bSrvStart.Text='启动'; $bSrvStart.Location=New-Object System.Drawing.Point(14,78); $bSrvStart.Size=New-Object System.Drawing.Size(88,28)
$g4.Controls.Add($bSrvStart)
$bSrvStop = New-Object System.Windows.Forms.Button
$bSrvStop.Text='停止'; $bSrvStop.Location=New-Object System.Drawing.Point(110,78); $bSrvStop.Size=New-Object System.Drawing.Size(88,28)
$g4.Controls.Add($bSrvStop)
$bSrvRestart = New-Object System.Windows.Forms.Button
$bSrvRestart.Text='重启'; $bSrvRestart.Location=New-Object System.Drawing.Point(206,78); $bSrvRestart.Size=New-Object System.Drawing.Size(88,28)
$g4.Controls.Add($bSrvRestart)
$bSrvRefresh = New-Object System.Windows.Forms.Button
$bSrvRefresh.Text='刷新状态'; $bSrvRefresh.Location=New-Object System.Drawing.Point(520,78); $bSrvRefresh.Size=New-Object System.Drawing.Size(84,28)
$g4.Controls.Add($bSrvRefresh)

# —— 日志
$lblLogTitle = New-Label '操作日志' 16 472 200 18 9 $true
$script:logBox = New-Object System.Windows.Forms.TextBox
$script:logBox.Multiline = $true; $script:logBox.ReadOnly = $true; $script:logBox.ScrollBars = 'Vertical'
$script:logBox.Location = New-Object System.Drawing.Point(16, 492)
$script:logBox.Size = New-Object System.Drawing.Size(616, 118)
$script:logBox.BackColor = [System.Drawing.Color]::White
$script:logBox.Font = New-Object System.Drawing.Font('Consolas', 8.5)
$form.Controls.Add($script:logBox)

$bShutdown = New-Object System.Windows.Forms.Button
$bShutdown.Text='全部停止'; $bShutdown.Location=New-Object System.Drawing.Point(16,620); $bShutdown.Size=New-Object System.Drawing.Size(110,28)
$form.Controls.Add($bShutdown)
$bOpenLog = New-Object System.Windows.Forms.Button
$bOpenLog.Text='打开日志目录'; $bOpenLog.Location=New-Object System.Drawing.Point(136,620); $bOpenLog.Size=New-Object System.Drawing.Size(120,28)
$form.Controls.Add($bOpenLog)
$bRefresh = New-Object System.Windows.Forms.Button
$bRefresh.Text='刷新'; $bRefresh.Location=New-Object System.Drawing.Point(266,620); $bRefresh.Size=New-Object System.Drawing.Size(110,28)
$form.Controls.Add($bRefresh)
$bTunLog = New-Object System.Windows.Forms.Button
$bTunLog.Text='隧道日志'; $bTunLog.Location=New-Object System.Drawing.Point(388,620); $bTunLog.Size=New-Object System.Drawing.Size(110,28)
$form.Controls.Add($bTunLog)
$bClose = New-Object System.Windows.Forms.Button
$bClose.Text='关闭窗口'; $bClose.Location=New-Object System.Drawing.Point(522,620); $bClose.Size=New-Object System.Drawing.Size(110,28)
$form.Controls.Add($bClose)

# ---------------------------------------------------------------- 事件
$bTunOn.Add_Click({ Start-TunnelAction })
$bTunOff.Add_Click({ Stop-TunnelAction })
$bBrOn.Add_Click({ Start-BridgeAction })
$bBrOff.Add_Click({ Stop-BridgeAction })
$bAutoOn.Add_Click({ Invoke-AutoScript '-Restore' '启用开机自启' })
$bAutoOff.Add_Click({ Invoke-AutoScript '' '关闭开机自启' })
$bSrvStart.Add_Click({ Invoke-Server 'start' '启动服务器模型服务' })
$bSrvStop.Add_Click({ Invoke-Server 'stop' '停止服务器模型服务' })
$bSrvRestart.Add_Click({ Invoke-Server 'restart' '重启服务器模型服务（约 2 分钟）' })
$bSrvRefresh.Add_Click({ Refresh-Server; Write-Log '已刷新服务器状态' })
$bRefresh.Add_Click({ Refresh-Local | Out-Null; if ((Get-TunnelSsh).Count -gt 0) { Refresh-Server }; Write-Log '已刷新状态' })

# 切换目标服务器：同步 $Server，并在隧道运行时按新目标重建隧道
$cbHost.Add_SelectedIndexChanged({
    $i = $cbHost.SelectedIndex
    if ($i -lt 0 -or $i -ge $script:Hosts.Count) { return }
    $script:Server = $script:Hosts[$i].Host
    if ($g1) { $g1.Text = '本地 · SSH 隧道（本地 8000 → ' + ($script:Server -replace '^ac@','') + ' 的 8000）' }
    Write-Log ('已切换目标服务器：' + $script:Server)
    if ((Get-Keeper).Count -gt 0 -or (Get-TunnelSsh).Count -gt 0) {
        Write-Log '检测到隧道正在运行，按新目标重建隧道…'
        Stop-TunnelAction
        Start-Sleep -Milliseconds 800
        Start-TunnelAction
    }
    Refresh-Local | Out-Null
    if ((Get-TunnelSsh).Count -gt 0) { Refresh-Server }
})
$bShutdown.Add_Click({
    if ([System.Windows.Forms.MessageBox]::Show('确定要停止【隧道】和【QQ 机器人】吗？`n（服务器上的模型服务不受影响）','全部停止',[System.Windows.Forms.MessageBoxButtons]::YesNo) -eq 'Yes') {
        Stop-BridgeAction; Stop-TunnelAction
    }
})
$bOpenLog.Add_Click({ Start-Process explorer.exe $QwenDir; Start-Process explorer.exe $BridgeDir })
$bTunLog.Add_Click({
    $tlog = Join-Path $QwenDir 'logs\tunnel.log'
    if (Test-Path -LiteralPath $tlog) { Start-Process notepad.exe $tlog }
    else { Write-Log "暂无隧道日志（$tlog）：隧道还没通过本控制台启动过。" }
})
$bClose.Add_Click({ $form.Close() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$script:tick = 0
$timer.Add_Tick({
    Refresh-Local | Out-Null
    $script:tick++
    if ($script:tick % 10 -eq 0 -and (Get-TunnelSsh).Count -gt 0 -and $bSrvRefresh.Enabled) {
        Refresh-Server
    }
})

# ---------------------------------------------------------------- 启动
Refresh-Local | Out-Null
if ($SelfTest) {
    Write-Host '=== SelfTest: 界面构建成功 ==='
    Write-Host ("目标  : {0}" -f $script:Server)
    Write-Host ("隧道 : {0}" -f $lblTunnel.Text)
    Write-Host ("       {0}" -f $lblTunnelSub.Text)
    Write-Host ("机器人: {0}" -f $lblBridge.Text)
    Write-Host ("自启  : {0}" -f $lblAuto.Text)
    Write-Host '--- 服务器状态（真实 ssh 查询）---'
    Refresh-Server
    Write-Host ("服务  : {0}" -f $lblSrv.Text)
    Write-Host ("       {0}" -f $lblSrvSub.Text)
    Write-Host '=== SelfTest OK ==='
    $form.Dispose()
    exit 0
}

Write-Log '控制台已启动。所有开关都是即时生效的。'
Refresh-Server
$timer.Start()
[void]$form.ShowDialog()
$timer.Stop()
