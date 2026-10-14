#Requires -Version 5.1
<#
  ============================================================
   SSH 免密准备：私钥 + known_hosts（供 Qwen SSH 隧道使用）
  ============================================================

   行为：
     1) 若 ~\.ssh\id_ed25519 已存在 -> 保留不动
        否则优先使用本包 files\ssh\id_ed25519（源机器的密钥，搬过来即可用）
        没有随包密钥或加 -GenerateNew 时，用 ssh-keygen 新生成一对
     2) 修正私钥/目录 ACL（Windows OpenSSH 会因为权限过宽拒绝使用私钥）
     3) 把随包的 known_hosts 片段并入 ~\.ssh\known_hosts（去重）
        —— 没有它，非交互式 ssh 会因 host key 未知而直接失败
     4) 试一次 BatchMode 登录，打印结论与后续要做什么

   用法：
     powershell -NoProfile -ExecutionPolicy Bypass -File setup-ssh.ps1
     powershell -NoProfile -ExecutionPolicy Bypass -File setup-ssh.ps1 -Server user@your-server-ip
     powershell -NoProfile -ExecutionPolicy Bypass -File setup-ssh.ps1 -GenerateNew

   注意：本文件必须保存为「UTF-8 带 BOM」。
#>
[CmdletBinding()]
param(
    [string]$Server = 'user@your-server-ip',
    [string]$BundledKeyDir,
    [switch]$GenerateNew,
    [switch]$NoKnownHosts,
    [switch]$SkipLoginTest
)

$ErrorActionPreference = 'Continue'

$sshDir  = Join-Path $env:USERPROFILE '.ssh'
$keyPriv = Join-Path $sshDir 'id_ed25519'
$keyPub  = Join-Path $sshDir 'id_ed25519.pub'
$known   = Join-Path $sshDir 'known_hosts'

function Say([string]$m, [string]$c) { if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } }

Say '==============================================' 'Cyan'
Say ' SSH 免密准备（Qwen 隧道）' 'Cyan'
Say '==============================================' 'Cyan'

$sshExe = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if (-not $sshExe) {
    Say '[FAIL] 找不到 ssh.exe。用管理员 PowerShell 执行：' 'Red'
    Say '       Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
    exit 3
}
Say ('ssh.exe : ' + $sshExe)

if (-not (Test-Path -LiteralPath $sshDir)) {
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    Say ('已创建 ' + $sshDir) 'Green'
}

# ---- 1. 私钥 --------------------------------------------------------------
$bundledPriv = $null; $bundledPub = $null
if ($BundledKeyDir) {
    $bundledPriv = Join-Path $BundledKeyDir 'id_ed25519'
    $bundledPub  = Join-Path $BundledKeyDir 'id_ed25519.pub'
}

if (Test-Path -LiteralPath $keyPriv) {
    Say ('[ OK ] 私钥已存在，保留：' + $keyPriv) 'Green'
}
elseif ((-not $GenerateNew) -and $bundledPriv -and (Test-Path -LiteralPath $bundledPriv)) {
    Copy-Item -LiteralPath $bundledPriv -Destination $keyPriv -Force
    if ($bundledPub -and (Test-Path -LiteralPath $bundledPub)) { Copy-Item -LiteralPath $bundledPub -Destination $keyPub -Force }
    Say ('[ OK ] 已部署随包私钥（源机器的密钥，可直接登录现有服务器）') 'Green'
}
else {
    Say '生成新的 ed25519 密钥对 ...'
    $comment = ('{0}@{1}' -f $env:USERNAME, $env:COMPUTERNAME)
    & ssh-keygen.exe -t ed25519 -C $comment -f $keyPriv -N '""' 2>&1 | ForEach-Object { Say ('       ' + $_) }
    if (Test-Path -LiteralPath $keyPriv) { Say '[ OK ] 已生成新密钥（需在 GPU 服务器上授权，见文末）' 'Green' }
    else { Say '[FAIL] ssh-keygen 失败' 'Red'; exit 4 }
}

# ---- 2. ACL ---------------------------------------------------------------
# Windows OpenSSH 拒绝使用权限过宽的私钥（"UNPROTECTED PRIVATE KEY FILE"）。
$me = ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME)
foreach ($target in @($keyPriv, $sshDir)) {
    if (-not (Test-Path -LiteralPath $target)) { continue }
    try {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & icacls.exe $target /inheritance:r /grant:r ($me + ':F') /grant:r ('SYSTEM:F') /grant:r ('Administrators:F') 2>&1 |
            ForEach-Object { }
        $ErrorActionPreference = $prev
        Say ('[ OK ] 已收紧 ACL：' + $target) 'Green'

        # ★ 对"目录"做 /inheritance:r 会连带清掉子文件唯一的继承权限：实测 ~\.ssh\config
        #   与 ~\.ssh\id_ed25519.pub 被清成 0 条 ACE，连属主都拒绝访问（ssh 于是静默忽略
        #   config，用户原有的 Host 别名全部失效）。所以目录收紧后必须给已存在的子文件
        #   补回显式授权，否则这一步会把用户的 ~\.ssh 弄坏。
        if ($target -eq $sshDir) {
            $regranted = 0
            Get-ChildItem -LiteralPath $sshDir -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
                & icacls.exe $_.FullName /grant:r ($me + ':F') 2>&1 | ForEach-Object { }
                $regranted++
            }
            Say ('[ OK ] 已为 ' + $regranted + ' 个子文件补回属主权限（抵消 /inheritance:r 的副作用）') 'Green'
        }
    } catch { Say ('[WARN] ACL 处理失败（若 ssh 报 UNPROTECTED KEY 再手工处理）：' + $_.Exception.Message) 'Yellow' }
}

# ---- 3. known_hosts -------------------------------------------------------
if (-not $NoKnownHosts) {
    $snippet = $null
    if ($BundledKeyDir) { $snippet = Join-Path $BundledKeyDir 'known_hosts.snippet' }
    if ($snippet -and (Test-Path -LiteralPath $snippet)) {
        $existing = ''
        if (Test-Path -LiteralPath $known) { $existing = (Get-Content -LiteralPath $known -Raw -ErrorAction SilentlyContinue) }
        if (-not $existing) { $existing = '' }
        $added = 0
        foreach ($line in (Get-Content -LiteralPath $snippet)) {
            $line = $line.Trim()
            if (-not $line) { continue }
            $hostPart = ($line -split '\s+')[0]
            if ($existing -match ('(?m)^' + [regex]::Escape($hostPart) + '\s')) { continue }
            Add-Content -LiteralPath $known -Value $line -Encoding UTF8
            $existing += "`n" + $line
            $added++
        }
        Say ('[ OK ] known_hosts 新增 ' + $added + ' 行（主机：' + (($snippet | ForEach-Object { (Get-Content $_ -TotalCount 1) }) ) + '）') 'Green'
    } else { Say '[WARN] 未提供 known_hosts.snippet，非交互 ssh 首次连接可能失败' 'Yellow' }
}

# ---- 4. 试登录 ------------------------------------------------------------
if (-not $SkipLoginTest) {
    Say ''
    Say ('试连接：' + $Server)
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    # 必须固定身份：服务器 sshd 常把 MaxAuthTries 设得很小（实测二卡机是 3），而
    # ~\.ssh 里往往不止一把私钥，逐把尝试会直接触发 "Too many authentication
    # failures"，并与 fail2ban 叠加成本机 IP 封禁（ICMP 仍通，TCP 全超时）。
    $out = (& ssh.exe -o BatchMode=yes -o IdentitiesOnly=yes -i $keyPriv -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new $Server 'echo QWEN_SSH_OK' 2>&1 | Out-String)
    $ErrorActionPreference = $prev
    if ($out -match 'QWEN_SSH_OK') {
        Say '[ OK ] 免密登录成功，隧道可以工作' 'Green'
    } else {
        Say '[WARN] 免密登录未成功（可能没连 VPN，或公钥尚未授权）' 'Yellow'
        Say ('       ' + ($out.Trim() -split "`n" | Select-Object -First 3 | ForEach-Object { $_ }) ) 'DarkGray'
        Say ''
        Say '把本机公钥授权到服务器（需要一次密码；从 cmd.exe 里跑最稳妥，PowerShell 会吃掉管道）：' 'Cyan'
        Say ('  scp "' + $keyPub + '" ' + $Server + ':/tmp/newkey.pub')
        Say ('  ssh ' + $Server + ' "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat /tmp/newkey.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && rm -f /tmp/newkey.pub && ssh-keygen -lf ~/.ssh/authorized_keys | tail -1"')
        Say ''
        Say '提示：先确认已连上 aTrust VPN 且能 ping 通服务器地址。' 'Gray'
    }
}

Say ''
Say '公钥指纹（贴给服务器核对用）：'
if (Test-Path -LiteralPath $keyPub) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & ssh-keygen.exe -lf $keyPub 2>&1 | ForEach-Object { Say ('  ' + $_) }
    $ErrorActionPreference = $prev
}
exit 0
