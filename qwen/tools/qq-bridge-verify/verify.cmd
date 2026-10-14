@echo off
rem ============================================================
rem  Launcher for verify.ps1
rem
rem  Why this exists: this machine's PowerShell execution policy
rem  blocks unsigned .ps1 files. This wrapper bypasses it for
rem  THIS invocation only (process scope). It does NOT change any
rem  machine-wide policy.
rem
rem  Usage (run from this folder):
rem     verify.cmd                 - interactive credential prompt, mode=target
rem     verify.cmd all             - full comparison test
rem     verify.cmd baseline        - control test only
rem     verify.cmd zero            - connectivity-only test
rem     verify.cmd target -SaveCreds   - run and cache credentials locally
rem     verify.cmd -ClearCreds         - delete cached credentials
rem
rem  NOTE: Keep this file ASCII-only (cmd.exe parses .cmd with the
rem  OEM code page; non-ASCII bytes here get treated as commands).
rem ============================================================
setlocal
set "PS=powershell.exe"
where pwsh.exe >nul 2>nul && set "PS=pwsh.exe"

set "ARGS="
:parse
if "%~1"=="" goto run
set "ARGS=%ARGS% %1"
shift
goto parse

:run
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify.ps1" %ARGS%
exit /b %errorlevel%
