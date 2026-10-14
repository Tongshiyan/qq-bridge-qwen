/**
 * Safety policy engine for the QQ -> DSH bridge.
 *
 * The bridge lets a QQ chat bot hand natural-language instructions to an AI coding
 * agent (DSH) that runs on the user's real Windows PC. This module is the *first*
 * line of defence: it classifies every incoming instruction BEFORE anything runs
 * and returns exactly one of three tiers:
 *
 *   - 'block'   -> destructive / exfiltration / privilege-escalation intent.
 *                  The bridge must refuse to execute, whatever the user says.
 *   - 'confirm' -> mutating but legitimate (file writes, installs, downloads,
 *                  process / service / registry / schedule changes). The bridge
 *                  must ask the human to confirm before executing.
 *   - 'safe'    -> read-only or query work, or phrasing this engine does not
 *                  recognise. DSH's own approval policy is the second line of
 *                  defence, so unrecognised phrasing defaults to 'safe' (with an
 *                  explanatory reason) instead of blocking routine requests.
 *
 * Precedence is fixed and deterministic: block > confirm > safe. All three tiers
 * are always evaluated, so the verdict is reproducible and the caller can see
 * everything that matched.
 *
 * The module is pure and dependency-free: no I/O, no `node:` imports, no shared
 * mutable state, and it never throws.
 */

// ---------------------------------------------------------------------------
// Default keyword lists (tier ordering inside each list is fixed)
// ---------------------------------------------------------------------------

/** Read-only / analytical verbs. Chinese entries match by substring, ASCII by word. */
const DEFAULT_SAFE_KEYWORDS = Object.freeze([
  // Chinese
  '查看', '列出', '显示', '读取', '搜索', '查找', '统计', '分析', '总结', '解释',
  '计算', '检查', '对比', '查询', '浏览', '看看', '看一下', '了解', '说明',
  // English
  'read', 'list', 'show', 'display', 'cat', 'ls', 'dir', 'find', 'grep', 'search',
  'inspect', 'count', 'analyze', 'analyse', 'summarise', 'summarize', 'explain',
  'compare', 'diff', 'print', 'view',
]);

/**
 * Mutation verbs. Deliberately mostly Chinese (the target users type Chinese) plus
 * unambiguous English file/OS mutations. Ambiguous English words that show up in
 * plain questions ("write a function", "create an array", "move the cursor") are
 * left OUT on purpose: their command forms (rm/cp/mv/Remove-Item/...) are already
 * covered by the command rules below, and over-triggering CONFIRM on ordinary
 * analytical questions is worse than letting DSH's own approval gate handle it.
 */
const DEFAULT_CONFIRM_KEYWORDS = Object.freeze([
  // Chinese
  '删除', '修改', '重写', '移动', '重命名', '创建', '新建', '写入', '安装', '卸载',
  '下载', '上传', '覆盖', '改名', '清空', '保存到', '替换', '复制', '拷贝', '压缩', '解压',
  '备份', '打包',
  // English
  'delete', 'remove', 'rename', 'uninstall', 'install', 'overwrite', 'erase',
  'download', 'upload', 'truncate', 'mkdir', 'rmdir',
]);

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------
// A rule is { id, zh, re } or { id, zh, when(haystack) }. `re` regexes are
// case-insensitive and must NOT be sticky/global. `when` receives the match form
// of the task (lowercased, whitespace-collapsed, full-width ASCII folded).

/** Destructive / exfiltration / privilege-escalation rules. */
const DEFAULT_BLOCK_RULES = Object.freeze([
  // ---- privilege escalation ----------------------------------------------
  // Elevated *sessions / accounts* are BLOCKED, not merely confirmed: `sudo -i`,
  // `sudo su`, `runas /user:Administrator`, `runas /savecred` and `-Verb RunAs`
  // hand the agent an administrative shell or persisted admin credentials, which
  // the trust model (the agent runs with the user's normal rights) must never
  // allow, because a human tap of "confirm" must not be able to grant that.
  // A plain `sudo <cmd>` / `runas /user:<other>` stays in the CONFIRM tier
  // (see DEFAULT_CONFIRM_RULES) as a single elevated command that still needs an
  // explicit human decision.
  {
    id: 'privilege-escalation-session',
    zh: '提权到管理员 / root 会话（sudo -i、sudo su、runas /user:Administrator、-Verb RunAs）',
    when: (t) =>
      /\bsudo\b\s+-[a-z]*[is]\b/.test(t) ||
      /\bsudo\s+(?:-[^\s]+\s+)*(?:su|bash|sh|zsh|cmd|powershell|pwsh)\b/.test(t) ||
      /\brunas\b[^\n]*\/user:\s*(?:\.\\)?(?:administrator|admin)\b/.test(t) ||
      /\brunas\b[^\n]*\/savecred\b/.test(t) ||
      /-verb\s+runas\b/.test(t),
  },
  // ---- destructive file / disk operations --------------------------------
  {
    id: 'rm-recursive-force',
    zh: 'rm 递归强制删除（rm -rf / -fr / -r -f / --recursive --force）',
    when: (t) =>
      /(?:^|[\s;&|(])rm(?=[\s;&|)]|$)/.test(t) &&
      /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)\b/.test(t) &&
      /(?:^|\s)(?:-[a-z]*f[a-z]*|--force)\b/.test(t),
  },
  {
    id: 'rm-root-target',
    zh: '删除根目录或整盘（rm ... / 或 rm -rf /）',
    re: /(?:^|[\s;&|(])rm\s+(?:-[a-z]+\s+)*\/(?:\s|$|\*)/i,
  },
  {
    id: 'rm-no-preserve-root',
    zh: 'rm --no-preserve-root 删除根目录',
    re: /--no-preserve-root/i,
  },
  {
    id: 'rmdir-s',
    zh: 'rmdir /s 递归删除目录',
    re: /(?:^|[\s;&|(])(?:rmdir|rd)\b[^\n]*\/s\b/i,
  },
  {
    id: 'del-s-f-q',
    zh: 'del /s /f /q 递归强制静默删除',
    re: /(?:^|[\s;&|(])(?:del|erase)\b[^\n]*\/s\b[^\n]*\/[fq]\b/i,
  },
  {
    id: 'del-drive-wildcard',
    zh: '删除整盘内容（del/erase 加盘符通配）',
    re: /(?:^|[\s;&|(])(?:del|erase)\b[^\n]*[a-z]:[\\/]\*/i,
  },
  {
    id: 'remove-item-recurse-force',
    zh: 'Remove-Item 递归强制删除（-Recurse -Force）',
    when: (t) =>
      /\bremove-item\b/.test(t) &&
      /-(?:recurse|force)\b/.test(t) &&
      /-(?:force|recurse)\b/.test(t),
  },
  {
    id: 'remove-item-drive-root',
    zh: 'Remove-Item 删除整盘根目录',
    re: /\bremove-item\b[^\n]*[a-z]:[\\/](?:\s|$|\*)/i,
  },
  {
    id: 'format-drive',
    zh: '格式化磁盘（format）',
    re: /\bformat\s+(?:[a-z]:|\/[a-z])/i,
  },
  {
    id: 'format-drive-cn',
    zh: '格式化磁盘 / 硬盘（中文）',
    re: /格式化[^\n]{0,8}(?:磁盘|硬盘|盘符|[a-z]:|u\s*盘|优盘)/i,
  },
  {
    id: 'diskpart',
    zh: 'diskpart 磁盘分区操作',
    re: /\bdiskpart\b/i,
  },
  {
    id: 'vssadmin-delete-shadows',
    zh: '删除卷影副本（vssadmin delete shadows）',
    re: /\bvssadmin\b[^\n]*\bdelete\s+shadows\b/i,
  },
  {
    id: 'wbadmin-delete',
    zh: '删除备份（wbadmin delete）',
    re: /\bwbadmin\b[^\n]*\bdelete\b/i,
  },
  {
    id: 'bcdedit',
    zh: 'bcdedit 修改启动配置',
    re: /\bbcdedit\b/i,
  },
  {
    id: 'cipher-w',
    zh: 'cipher /w 擦除磁盘空闲空间',
    re: /\bcipher\b[^\n]*\/w\b/i,
  },
  {
    id: 'fork-bomb',
    zh: 'fork 炸弹（:(){ :|:& };:）',
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i,
  },
  {
    id: 'fork-bomb-batch',
    zh: '批处理 fork 炸弹（%0|%0）',
    re: /%0\s*\|\s*%0/i,
  },
  {
    id: 'shutdown',
    zh: '关机 / 重启系统（shutdown）',
    re: /(?:^|[\s;&|(])shutdown\b[^\n]*(?:\/[rsp]\b|-(?:r|h|now)\b)/i,
  },
  {
    id: 'shutdown-cn',
    zh: '关机 / 重启电脑（中文）',
    re: /(?:重启|关机|注销|关闭)[^\n]{0,4}(?:电脑|系统|计算机|机器|服务器|主机)/i,
  },
  {
    id: 'power-cmdlets',
    zh: 'Stop-Computer / Restart-Computer',
    re: /\b(?:stop-computer|restart-computer)\b/i,
  },

  // ---- Defender / firewall / security posture ----------------------------
  {
    id: 'mppreference',
    zh: '修改 Windows Defender 配置（Set-MpPreference / Add-MpPreference）',
    re: /\b(?:set|add)-mppreference\b/i,
  },
  {
    id: 'defender-disable',
    zh: '关闭 Defender 实时防护（DisableRealtimeMonitoring 等）',
    re: /\bdisable(?:realtimemonitoring|antispyware|behaviormonitoring|ioavprotection|antivirus|scriptscanning|blockatfirstseen)\b/i,
  },
  {
    id: 'defender-disable-cn',
    zh: '关闭杀毒 / 防护（中文）',
    re: /(?:关闭|停用|禁用|绕过)[^\n]{0,6}(?:defender|windows\s*安全中心|杀毒|防护|实时保护|病毒防护)/i,
  },
  {
    id: 'set-executionpolicy-bypass',
    zh: '放开脚本执行策略（Set-ExecutionPolicy Unrestricted/Bypass）',
    re: /\bset-executionpolicy\b[^\n]*\b(?:unrestricted|bypass)\b/i,
  },
  {
    id: 'reg-delete',
    zh: '删除注册表项（reg delete）',
    re: /\breg\s+delete\b/i,
  },
  {
    id: 'netsh-firewall',
    zh: '修改防火墙（netsh firewall / advfirewall）',
    re: /\bnetsh\s+(?:firewall|advfirewall)\b/i,
  },
  {
    id: 'netsh-firewall-off',
    zh: '关闭防火墙 / 网络防护（netsh）',
    re: /\bnetsh\b[^\n]*(?:\bset\s+opmode\s+disable\b|\boff\b|\bdisable\b)/i,
  },
  {
    id: 'firewall-off-cn',
    zh: '关闭防火墙（中文）',
    re: /(?:关闭|停用|禁用)[^\n]{0,6}防火墙/i,
  },
  {
    id: 'wevtutil-clear',
    zh: '清除事件日志（wevtutil cl / Clear-EventLog）',
    re: /(?:\bwevtutil\b[^\n]*\bcl\b|\bclear-eventlog\b)/i,
  },
  {
    id: 'icacls-grant-everyone',
    zh: '给所有人授予完全控制（icacls /grant Everyone）',
    re: /\bicacls\b[^\n]*\/grant\b[^\n]*(?:everyone|所有人|authenticated users)/i,
  },
  {
    id: 'net-user-add',
    zh: '创建用户 / 加入管理员组（net user|localgroup /add）',
    re: /\bnet\s+(?:user|localgroup)\b[^\n]*\/add\b/i,
  },

  // ---- piping remote content into a shell --------------------------------
  {
    id: 'pipe-to-shell',
    zh: '把内容管道交给 shell 执行（| sh / bash）',
    re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|dash)\b/i,
  },
  {
    id: 'pipe-to-powershell',
    zh: '把内容管道交给 PowerShell / IEX 执行',
    re: /\|\s*(?:sudo\s+)?(?:iex|invoke-expression|powershell|pwsh)\b/i,
  },
  {
    id: 'download-pipe-to-interpreter',
    zh: '下载后直接交给解释器执行（curl|wget|iwr ... | python/node/...）',
    re: /(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|bitsadmin|aria2c)\b[^\n|]*\|[^\n]*\b(?:iex|invoke-expression|powershell|pwsh|python3?|node|perl|ruby)\b/i,
  },
  {
    id: 'invoke-expression',
    zh: 'Invoke-Expression 动态执行代码',
    re: /\binvoke-expression\b/i,
  },
  {
    id: 'iex',
    zh: 'IEX 动态执行代码',
    re: /\biex\b/i,
  },
  {
    id: 'encoded-command',
    zh: 'PowerShell 编码命令（-EncodedCommand / -e <base64>）',
    when: (t) =>
      /-encodedcommand\b/.test(t) ||
      /\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|en|enc|encodedcommand)\s+[a-z0-9+/=]{20,}/.test(t),
  },
  {
    id: 'frombase64string',
    zh: 'FromBase64String 解码执行',
    re: /\bfrombase64string\b/i,
  },
  {
    id: 'base64-decode-pipe',
    zh: 'base64 解码后管道执行（base64 -d |）',
    re: /\bbase64\b[^\n]*\s(?:-d|--decode|-D)\b[^\n]*\|/i,
  },
  {
    id: 'certutil-decode',
    zh: 'certutil 解码载荷（-decode / -urlcache）',
    re: /\bcertutil\b[^\n]*\s-(?:decode|decodehex|urlcache)\b/i,
  },

  // ---- credential / session theft ----------------------------------------
  {
    id: 'browser-login-data',
    zh: '读取浏览器凭据库（Login Data）',
    re: /\blogin\s*data\b/i,
  },
  {
    id: 'firefox-key4',
    zh: '读取 Firefox 密钥库（key4.db / logins.json）',
    re: /\b(?:key[34]\.db|logins\.json|signons\.sqlite)\b/i,
  },
  {
    id: 'browser-cookie-db',
    zh: '读取浏览器 cookie 数据库',
    re: /(?:读取|查看|导出|复制|上传|外发|发送|打开|cat|type|copy|read|dump|export|upload|steal|grab|exfiltrat\w*)[^\n]{0,30}\bcookies?(?:\.sqlite|\.db|\s*(?:数据库|文件|库))?/i,
  },
  {
    id: 'browser-cookie-db-rev',
    zh: '读取浏览器 cookie 数据库（倒序表述）',
    re: /\bcookies?(?:\.sqlite|\.db)\b[^\n]{0,30}(?:读取|导出|上传|发送|外发|复制|解密)/i,
  },
  {
    id: 'browser-profile-path',
    zh: '访问浏览器用户配置目录中的会话数据',
    re: /[\\/](?:user data|default|profile \d+|cookies?)[\\/][^\n]*\b(?:cookies?|login data|web data)\b/i,
  },
  {
    id: 'ssh-private-key',
    zh: '读取 SSH 私钥（.ssh/id_rsa / id_ed25519）',
    re: /(?:\.ssh[\\/]id_(?:rsa|dsa|ecdsa|ed25519)\b|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b)/i,
  },
  {
    id: 'ssh-authorized-keys',
    zh: '篡改 SSH 授权公钥（authorized_keys）',
    re: /\bauthorized_keys\b/i,
  },
  {
    id: 'windows-hives',
    zh: '读取 Windows 凭据数据库（SAM / SECURITY / SYSTEM hive）',
    re: /(?:[\\/]config[\\/](?:sam|security|system)\b|\bhklm[\\/](?:sam|security)\b|\b(?:sam|security)\s+hive\b|\breg\s+save\b[^\n]*\b(?:sam|security|system)\b|\bntds\.dit\b)/i,
  },
  {
    id: 'mimikatz',
    zh: '凭据窃取工具（mimikatz / sekurlsa / lsadump）',
    re: /\b(?:mimikatz|sekurlsa|lsadump)\b/i,
  },
  {
    id: 'lsass-dump',
    zh: '转储 LSASS 内存（凭据窃取）',
    re: /(?:\bprocdump\b[^\n]*lsass|comsvcs\.dll[^\n]*minidump|\blsass\b[^\n]*(?:dump|minidump)|(?:dump|minidump)[^\n]*\blsass\b)/i,
  },
  {
    id: 'wifi-key-clear',
    zh: '导出已保存的 Wi-Fi 密码（netsh wlan ... key=clear）',
    re: /(?:\bnetsh\s+wlan\b[^\n]*key\s*=\s*clear|(?:导出|获取|查看|列出)[^\n]{0,10}(?:wifi|无线网络?)[^\n]{0,10}密码)/i,
  },

  // ---- bulk exfiltration phrasing ----------------------------------------
  {
    id: 'exfiltrate',
    zh: '外发 / 窃取数据（exfiltrate）',
    re: /\bexfiltrat(?:e|es|ed|ing|ion)\b/i,
  },
  {
    id: 'upload-credentials-en',
    zh: '上传凭据（upload ... credentials / passwords / cookies）',
    re: /\b(?:upload|post|send|exfiltrate)\b[^\n]{0,40}\b(?:credentials?|passwords?|cookies?|secrets?|private\s+keys?|tokens?|ssh\s+keys?)\b/i,
  },
  {
    id: 'upload-credentials-cn',
    zh: '上传 / 外发 密码、cookie、凭据、密钥（中文）',
    re: /(?:上传|上载|外发|发送到|发送给|发到|传到|回传|转发到|泄露|窃取|带走)[^\n]{0,30}(?:密码|口令|cookie|凭据|凭证|密钥|私钥|token|令牌|账号|账户|身份证)/i,
  },
  {
    id: 'upload-credentials-cn-rev',
    zh: '把密码 / cookie / 凭据 / 密钥发出（中文倒序表述）',
    re: /(?:密码|口令|cookie|凭据|凭证|密钥|私钥|token|令牌)[^\n]{0,20}(?:上传|上载|外发|发送到|发送给|发到|传到|回传|转发到|发出去|传出去)/i,
  },
]);

/** Mutating but legitimate rules. */
const DEFAULT_CONFIRM_RULES = Object.freeze([
  {
    id: 'file-write-cmdlets',
    zh: '写入文件（New-Item / Set-Content / Add-Content / Out-File / Set-Item / Clear-Content）',
    re: /\b(?:new-item|set-content|add-content|out-file|set-item|clear-content|new-file|touch|tee-object|export-csv|export-clixml|export-pssession)\b/i,
  },
  {
    id: 'file-mutate-cmdlets',
    zh: '移动 / 复制 / 重命名 / 删除文件（Move-Item / Copy-Item / Rename-Item / Remove-Item）',
    re: /\b(?:move-item|copy-item|rename-item|remove-item)\b/i,
  },
  {
    id: 'unix-file-mutation',
    zh: 'Unix 文件操作（rm / cp / mv / mkdir / rmdir / truncate / dd / chmod / chown / ln / tee / sed -i）',
    re: /(?:^|[\s;&|(])(?:rm|cp|mv|mkdir|rmdir|truncate|dd|chmod|chown|ln|tee|sed\s+-i)(?=[\s;&|)]|$)/i,
  },
  {
    id: 'find-delete',
    zh: 'find 直接删除匹配文件（-delete）',
    re: /\bfind\b[^\n]*-delete\b/i,
  },
  {
    id: 'windows-delete',
    zh: 'Windows 删除命令（del / erase / rd）',
    re: /(?:^|[\s;&|(])(?:del|erase|rd)(?=[\s;&|)]|$)/i,
  },
  {
    id: 'write-to-path-cn',
    zh: '把内容写入指定文件 / 路径（中文，如「把结果输出到 out.txt」）',
    re: /(?:写|存|保存|输出|导出|下载|重定向)[^\n]{0,6}(?:到|至|进)[^\n]{0,20}(?:文件|[a-z]:[\\/]|\/|\.{1,2}[\\/]|[^\s，。]{1,40}\.[a-z0-9]{1,8}\b)/i,
  },
  {
    id: 'package-manager',
    zh: '包管理器安装 / 卸载 / 升级（npm / pnpm / winget / choco / pip ...）',
    re: /\b(?:npm|pnpm|yarn|bun|winget|choco|scoop|pip3?|gem|cargo|dotnet|apt(?:-get)?|brew|pacman|dnf|yum|npx|uv)\s+(?:i|install|add|uninstall|remove|rm|upgrade|update|ci|link|init|create|publish|global|tool|exec|dlx)\b/i,
  },
  {
    id: 'git-mutation',
    zh: 'git 变更操作（clone / push / pull / reset / clean / checkout / commit ...）',
    re: /\bgit\s+(?:clone|push|pull|fetch|merge|rebase|reset|clean|checkout|switch|restore|commit|rm|mv|stash\s+(?:pop|drop|apply|push)|tag|cherry-pick|apply|am|init|submodule|gc|prune|filter-branch|remote\s+(?:add|remove|set-url)|config|branch\s+-(?:d|D|m|M|delete|move))\b/i,
  },
  {
    id: 'network-access',
    zh: '网络请求 / 下载（curl / wget / Invoke-WebRequest / scp / ssh ...）',
    re: /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin|ftp|scp|sftp|ssh|telnet)\b/i,
  },
  {
    id: 'process-control',
    zh: '启动 / 结束进程（Start-Process / Stop-Process / taskkill）',
    re: /\b(?:start-process|stop-process|taskkill|killall|kill\s+-\w+)\b/i,
  },
  {
    id: 'service-control',
    zh: '服务变更（sc config / net start / New-Service / Start-Service ...）',
    re: /(?:\bsc(?:\.exe)?\s+(?:config|create|delete|start|stop|failure|qdescription)\b|\bnet\s+(?:start|stop|pause|continue)\b|\b(?:new|set|start|stop|restart|remove|suspend|resume)-service\b)/i,
  },
  {
    id: 'registry-write',
    zh: '注册表写入（reg add / Set-ItemProperty / regedit）',
    re: /\b(?:reg\s+(?:add|import|copy|save|restore|load|unload)\b|new-itemproperty|set-itemproperty|remove-itemproperty|regedit|regedt32)\b/i,
  },
  {
    id: 'scheduled-task',
    zh: '计划任务（schtasks / Register-ScheduledTask）',
    re: /\b(?:schtasks|register-scheduledtask|unregister-scheduledtask|disable-scheduledtask|enable-scheduledtask)\b/i,
  },
  {
    id: 'powercfg',
    zh: '电源配置变更（powercfg）',
    re: /\bpowercfg\b/i,
  },
  {
    id: 'privilege-escalation-runas',
    zh: '提权执行（sudo / runas；管理员会话已在 BLOCK 层拦截）',
    re: /(?:\bsudo\b|\brunas\b|-verb\s+runas)/i,
  },
  {
    id: 'output-redirection',
    zh: '输出重定向写入文件（> 或 >>）',
    when: (t) => detectRedirection(t) !== null,
  },
]);

/** Read-only system queries and read-only command families. */
const DEFAULT_SAFE_RULES = Object.freeze([
  {
    id: 'disk-query',
    zh: '磁盘 / 空间查询',
    re: /(?:磁盘|硬盘|空间|剩余空间|可用空间|盘符|\bdf\b|\bdu\b|disk\s+(?:space|free|usage|part)|get-psdrive|get-volume|get-disk|get-partition)/i,
  },
  {
    id: 'process-query',
    zh: '进程查询',
    re: /(?:进程|\bprocess(?:es)?\b|\btasklist\b|\bget-process\b|\bps\b|\btop\b)/i,
  },
  {
    id: 'memory-query',
    zh: '内存查询',
    re: /(?:内存|memory|get-ciminstance\s+win32_operatingsystem)/i,
  },
  {
    id: 'network-query',
    zh: '网络状态查询',
    re: /(?:网络状态|网络连接|网络配置|\bipconfig\b|\bnetstat\b|\bifconfig\b|get-netipconfiguration|get-netadapter|get-nettcpconnection|\bping\b|\bnslookup\b|\btracert\b|resolve-dnsname)/i,
  },
  {
    id: 'git-readonly',
    zh: 'git 只读查询',
    re: /\bgit\s+(?:status|log|diff|show|branch|describe|rev-parse|ls-files|shortlog|blame|whatchanged|reflog|remote\s+-v|stash\s+list|config\s+--get)\b/i,
  },
  {
    id: 'readonly-cmdlets',
    zh: '只读 PowerShell 命令',
    re: /\b(?:get-childitem|get-content|get-item|get-itemproperty|get-service|get-command|get-help|get-member|get-location|get-date|get-filehash|get-acl|get-eventlog|get-winevent|get-hotfix|get-computerinfo|get-counter|select-string|select-object|where-object|measure-object|sort-object|group-object|format-table|format-list|test-path|resolve-path|split-path|compare-object|convertfrom-json|convertto-json|import-csv|out-string)\b/i,
  },
  {
    id: 'readonly-shell',
    zh: '只读 shell 命令',
    re: /(?:^|[\s;&|(])(?:ls|dir|cat|head|tail|less|more|wc|stat|tree|pwd|find|grep|rg|awk|sort|uniq|cut|which|whereis|echo|printenv|env|whoami|hostname|systeminfo|date|type)(?=[\s;&|)]|$)/i,
  },
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse all whitespace runs to single spaces and trim. Casing is preserved:
 * this exact string is returned as `normalized`.
 */
function normalizeTask(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Build the string used for matching: lowercase plus full-width ASCII folded to
 * half-width (Chinese IMEs happily produce ｒｍ －ｒｆ ｜ or ＞). Reporting still
 * uses the un-folded `normalized` value.
 */
function toMatchForm(normalized) {
  return normalized
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn one keyword into a rule. ASCII keywords match on word boundaries (so `ls`
 * does not fire inside "also" and `read` does not fire inside "already"); non-ASCII
 * keywords match as plain substrings, which is what Chinese needs.
 */
function makeKeywordRule(kind, labelZh, keyword) {
  const id = `${kind}:${keyword}`;
  const zh = `${labelZh}「${keyword}」`;
  if (/^[\x20-\x7E]+$/.test(keyword)) {
    const parts = keyword.toLowerCase().split(/\s+/).map(escapeRegExp);
    try {
      return { id, zh, re: new RegExp(`(?<!\\w)(?:${parts.join('[\\s_-]+')})(?!\\w)`, 'i') };
    } catch {
      // Fall through to substring matching if the boundary form cannot compile.
    }
  }
  const needle = keyword.toLowerCase();
  return { id, zh, when: (t) => t.includes(needle) };
}

function isPathLikeTarget(token) {
  if (!token) return false;
  if (/^&\d$/.test(token)) return false; // 2>&1 / 2>&2 are stream duplications
  if (/^\d+$/.test(token)) return false; // "2 > 1" style comparisons
  if (/^\$\{?\w+\}?$/.test(token)) return false; // "$x > $y" comparisons
  if (token.length <= 2 && /^[a-z]$/i.test(token)) return false; // "a > b"
  if (/^[a-z]:[\\/]/i.test(token)) return true; // C:\...
  if (/^(?:\\\\|\/|~[\\/]|\.{1,2}[\\/])/.test(token)) return true; // UNC, /tmp, ./, ../
  if (/[\\/]/.test(token)) return true;
  if (/^[\w.$-]+\.[a-z0-9]{1,8}$/i.test(token)) return true; // out.txt, log.json
  if (/^(?:nul|con|prn|aux)$/i.test(token)) return true;
  if (token.length >= 3 && /^[\w.$-]+$/.test(token)) return true; // bare filename
  return false;
}

/** Return the redirection target when the text writes to a path-like target. */
function detectRedirection(text) {
  const re = /(?:^|[^=<>!\-])(>>?)\s*([^\s>|&;]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (isPathLikeTarget(m[2])) return m[2];
  }
  return null;
}

/**
 * Compile caller-supplied regex sources. Anything invalid is skipped and reported
 * instead of thrown, so a typo in config can never take the bridge down.
 */
function compileExtraRules(sources, tier, errors) {
  const rules = [];
  if (sources === undefined || sources === null) return rules;
  if (!Array.isArray(sources)) {
    errors.push(`options.extra${tier} 不是数组，已忽略。`);
    return rules;
  }
  sources.forEach((src, i) => {
    const label = `extra${tier}[${i}]`;
    if (typeof src !== 'string' || src.trim() === '') {
      errors.push(`${label} 不是有效的正则字符串，已跳过：${JSON.stringify(src)}`);
      return;
    }
    try {
      rules.push({ id: `${label}:${src}`, zh: `自定义规则 /${src}/`, re: new RegExp(src, 'i') });
    } catch (e) {
      errors.push(`${label} 正则无效，已跳过：${src}（${e.message}）`);
    }
  });
  return rules;
}

/** Resolve a keyword override: a valid array wins, anything else falls back. */
function resolveKeywords(value, fallback, optionName, errors) {
  if (value === undefined || value === null) return fallback.slice();
  if (!Array.isArray(value)) {
    errors.push(`options.${optionName} 不是数组，已改用默认关键词。`);
    return fallback.slice();
  }
  const cleaned = [];
  for (const kw of value) {
    if (typeof kw === 'string' && kw.trim() !== '') cleaned.push(kw.trim());
    else errors.push(`options.${optionName} 含非字符串项，已跳过：${JSON.stringify(kw)}`);
  }
  return cleaned;
}

/** Test every rule, in declared order, and return the ones that matched. */
function collectHits(rules, text) {
  const hits = [];
  for (const rule of rules) {
    let hit = false;
    try {
      hit = rule.re ? rule.re.test(text) : Boolean(rule.when(text));
    } catch {
      hit = false; // A misbehaving custom predicate must never break the verdict.
    }
    if (hit) hits.push(rule);
  }
  return hits;
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify one QQ instruction.
 *
 * @param {string} task Natural-language (or raw command) instruction from QQ.
 * @param {object} [options]
 * @param {string[]} [options.extraSafe]    Extra regex sources treated as safe.
 * @param {string[]} [options.extraConfirm] Extra regex sources requiring confirmation.
 * @param {string[]} [options.extraBlock]   Extra regex sources treated as blocked.
 * @param {string[]} [options.safeKeywords]    Replace the default safe verbs.
 * @param {string[]} [options.confirmKeywords] Replace the default confirm verbs.
 * @returns {{
 *   verdict: 'SAFE'|'CONFIRM'|'BLOCK',
 *   tier: 'safe'|'confirm'|'block',
 *   reasons: string[],
 *   matched: string[],
 *   normalized: string
 * }} Verdict plus the deciding tier, Chinese explanations, the matched rule/keyword
 *    ids (prefixed `block:` / `confirm:` / `safe:`, in evaluation order) and the
 *    whitespace-collapsed task that was evaluated.
 */
export function classify(task, options = {}) {
  const reasons = [];
  const matched = [];
  const optionErrors = [];

  try {
    // ---- malformed input: refuse rather than guess -----------------------
    if (typeof task !== 'string') {
      return {
        verdict: 'BLOCK',
        tier: 'block',
        reasons: [
          `任务内容类型不正确（收到 ${describeType(task)}），为防止误执行，判定为 BLOCK。`,
        ],
        matched: ['block:malformed-input'],
        normalized: '',
      };
    }

    const normalized = normalizeTask(task);
    const hay = toMatchForm(normalized);

    // ---- assemble the rule set (fixed order, deterministic) --------------
    const opts = options && typeof options === 'object' ? options : {};
    const safeKeywords = resolveKeywords(
      opts.safeKeywords, DEFAULT_SAFE_KEYWORDS, 'safeKeywords', optionErrors,
    );
    const confirmKeywords = resolveKeywords(
      opts.confirmKeywords, DEFAULT_CONFIRM_KEYWORDS, 'confirmKeywords', optionErrors,
    );

    const blockRules = [
      ...DEFAULT_BLOCK_RULES,
      ...compileExtraRules(opts.extraBlock, 'Block', optionErrors),
    ];
    const confirmRules = [
      ...DEFAULT_CONFIRM_RULES,
      ...confirmKeywords.map((kw) => makeKeywordRule('confirm-kw', '变更类动词', kw)),
      ...compileExtraRules(opts.extraConfirm, 'Confirm', optionErrors),
    ];
    const safeRules = [
      ...DEFAULT_SAFE_RULES,
      ...safeKeywords.map((kw) => makeKeywordRule('safe-kw', '只读类动词', kw)),
      ...compileExtraRules(opts.extraSafe, 'Safe', optionErrors),
    ];

    // ---- evaluate all three tiers (block > confirm > safe) ---------------
    const blockHits = collectHits(blockRules, hay);
    const confirmHits = collectHits(confirmRules, hay);
    const safeHits = collectHits(safeRules, hay);

    for (const r of blockHits) matched.push(`block:${r.id}`);
    for (const r of confirmHits) matched.push(`confirm:${r.id}`);
    for (const r of safeHits) matched.push(`safe:${r.id}`);

    if (blockHits.length > 0) {
      for (const r of blockHits) reasons.push(`禁止执行：${r.zh}（规则 ${r.id}）`);
      if (confirmHits.length > 0 || safeHits.length > 0) {
        reasons.push('同时命中较低风险规则，但禁止规则优先级最高，直接阻断。');
      }
      reasons.push(...optionErrors);
      return { verdict: 'BLOCK', tier: 'block', reasons, matched, normalized };
    }

    if (confirmHits.length > 0) {
      for (const r of confirmHits) reasons.push(`需要确认：${r.zh}（规则 ${r.id}）`);
      reasons.push('判定为 CONFIRM：该操作会改变文件系统或系统状态，需用户确认后才能执行。');
      reasons.push(...optionErrors);
      return { verdict: 'CONFIRM', tier: 'confirm', reasons, matched, normalized };
    }

    if (safeHits.length > 0) {
      // Requirement: a clean safe match carries no reasons (only option warnings).
      reasons.push(...optionErrors);
      return { verdict: 'SAFE', tier: 'safe', reasons, matched, normalized };
    }

    reasons.push(
      normalized === ''
        ? '任务内容为空，无需执行任何操作，默认判定为 SAFE。'
        : '未命中任何安全或危险规则，默认判定为 SAFE（DSH 自身的审批策略作为第二道防线）。',
    );
    reasons.push(...optionErrors);
    return { verdict: 'SAFE', tier: 'safe', reasons, matched, normalized };
  } catch (e) {
    // Absolute last resort: this module must never throw and must never let an
    // instruction through on an unexpected failure.
    return {
      verdict: 'BLOCK',
      tier: 'block',
      reasons: [
        `策略引擎内部错误（${e && e.message ? e.message : String(e)}），出于安全考虑判定为 BLOCK。`,
      ],
      matched: ['block:internal-error'],
      normalized: typeof task === 'string' ? normalizeTask(task) : '',
    };
  }
}

export default classify;
