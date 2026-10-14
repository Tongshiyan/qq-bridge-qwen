@echo off
rem ============================================================
rem  Launcher for install-task.ps1 -- DSH-QQ bridge auto-start.
rem
rem  Why this exists: this machine's PowerShell execution policy
rem  blocks unsigned .ps1 files
rem  ("cannot be loaded ... is not digitally signed").
rem  This wrapper bypasses that policy for THIS invocation only
rem  (-ExecutionPolicy Bypass). It does NOT change any machine-wide
rem  policy and does not touch the registry.
rem
rem  Usage (run from the qq-bridge folder):
rem     scripts\install-task.cmd -Action status
rem     scripts\install-task.cmd -Action install
rem     scripts\install-task.cmd -Action uninstall
rem     scripts\install-task.cmd -Action start
rem     scripts\install-task.cmd -Action stop
rem     scripts\install-task.cmd -Action show
rem
rem  "install" and "uninstall" need an ELEVATED prompt:
rem  press Win+X, pick "Terminal (Admin)", cd to the project folder.
rem  status / start / stop work without elevation.
rem
rem  Arguments are forwarded verbatim with %*, so both
rem  "-Action status" and the bare positional "status" work.
rem  With no argument at all it just prints the status.
rem
rem  NOTE: Keep this file ASCII-only. cmd.exe parses .cmd with the
rem  OEM code page, so non-ASCII bytes here would be treated as
rem  commands and break execution.
rem ============================================================
setlocal
set "PS=powershell.exe"
where pwsh.exe >nul 2>nul && set "PS=pwsh.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1" %*
exit /b %errorlevel%
