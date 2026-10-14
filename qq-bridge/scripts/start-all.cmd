@echo off
rem ============================================================
rem  Manual entry point for the QQ robot stack.
rem  All logic lives in start-all.ps1 (kept in one place, one file
rem  to change). Autostart does NOT use this file: it uses a logon
rem  scheduled task that runs the .ps1 hidden, so nothing flashes on
rem  screen. Running this .cmd from a terminal gives back a console,
rem  which is what you want when starting it by hand.
rem
rem  Usage:  scripts\start-all.cmd  [status]
rem
rem  NOTE: keep this file ASCII-only (cmd.exe uses the OEM code page).
rem ============================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
exit /b %errorlevel%
