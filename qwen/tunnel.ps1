# ---------------------------------------------------------------------------
# Qwen3.8-27B SSH tunnel keeper (Windows PowerShell)
#
# Maps the server's 127.0.0.1:8000 to local 127.0.0.1:8000 and reconnects
# automatically when the link drops. Used by DeepSeek Harness as a custom
# OpenAI-compatible provider endpoint.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File D:\dsh-workspace\qwen\tunnel.ps1
#
# Stop: Ctrl-C or close the window.
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
# UTF-8 files without BOM as ANSI/GBK, which corrupts non-ASCII comments and
# breaks parsing. Keep it ASCII.
#
# One-time passwordless setup:
#   ssh-keygen -t ed25519 -C "<you>@local"
#   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@your-server-ip "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
#
# WHY THIS TUNNEL PINS ONE IDENTITY (-i / IdentitiesOnly, 2026-10-14):
#   The GPU servers run sshd with a very low MaxAuthTries (the new box uses 3).
#   With more than one private key in ~\.ssh (id_rsa + id_ed25519, plus any
#   agent keys) ssh offers several identities, exceeds the limit, and drops
#   with "Too many authentication failures"; fail2ban then bans this PC's VPN
#   egress IP for 24h. A ban looks exactly like a dead server - ICMP is still
#   answered while every TCP port times out. Pinning the identity here keeps
#   the tunnel independent of the user's ~\.ssh\config.
#
# Optional: -ForwardHost makes the forward land on another machine reachable
#   from $Server (e.g. VPN cannot reach the new box, but the old one can):
#     .\tunnel.ps1 -Server user@old-server-ip -ForwardHost new-server-ip
#
# Verify tunnel from another window (use curl.exe, not curl):
#   curl.exe http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"
# ---------------------------------------------------------------------------

param(
    [string]$Server     = "user@your-server-ip",
    [int]   $LocalPort  = 8000,
    [int]   $RemotePort = 8000,
    [int]   $RetryDelay = 5,
    # Where the remote end dials. 127.0.0.1 = the server itself; another
    # address hops through $Server to a different machine.
    [string]$ForwardHost = "127.0.0.1",
    # One pinned identity, so a multi-key ~\.ssh cannot exhaust MaxAuthTries.
    [string]$IdentityFile = "$env:USERPROFILE\.ssh\id_ed25519"
)

$ErrorActionPreference = "Continue"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Qwen3.8-27B tunnel keeper" -ForegroundColor Cyan
Write-Host (" local  127.0.0.1:{0}  ->  {1} (127.0.0.1:{2})" -f $LocalPort, $Server, $RemotePort) -ForegroundColor Cyan
Write-Host " Press Ctrl-C to quit" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

while ($true) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host ("[{0}] opening tunnel ..." -f $ts) -ForegroundColor Yellow

    # -C = SSH transport compression.
    # Measured: this PC reaches the server through the aTrust VPN with only
    # 3-15 KB/s of upload. DSH re-uploads the whole conversation context on
    # every step (100k tokens ~ 400-500 KB of JSON), so that upload is the
    # real bottleneck. With -C the same request went 81.5s -> 3.5s, and a
    # 256KB text upload went 4.5 KB/s -> 38.7 KB/s.
    # NOTE: keep this file ASCII-only (see header comment).
    ssh -C -N `
        -i $IdentityFile `
        -o IdentitiesOnly=yes `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ExitOnForwardFailure=yes `
        -o ConnectTimeout=10 `
        -o TCPKeepAlive=yes `
        -L "${LocalPort}:${ForwardHost}:${RemotePort}" `
        $Server

    $code = $LASTEXITCODE
    $ts = Get-Date -Format "HH:mm:ss"

    if ($code -eq 255) {
        Write-Host ("[{0}] connect failed (network / auth / host unreachable), retry in {1}s" -f $ts, $RetryDelay) -ForegroundColor Red
    }
    elseif ($code -eq 0) {
        Write-Host ("[{0}] tunnel closed normally, retry in {1}s" -f $ts, $RetryDelay) -ForegroundColor Red
    }
    else {
        Write-Host ("[{0}] tunnel dropped (exit {1}), retry in {2}s" -f $ts, $code, $RetryDelay) -ForegroundColor Red
    }
    Write-Host "        if it says the port is in use, a tunnel is already running - you can close this." -ForegroundColor DarkGray
    Write-Host ""

    Start-Sleep -Seconds $RetryDelay
}
