@echo off
rem Marker script used by tests/spawn-cmd-probe.js to verify that .cmd files
rem must be launched via cmd.exe on Node 20+ (CVE-2024-27980).
rem Keep ASCII-only: cmd.exe parses .cmd using the OEM code page.
echo SPAWN_MARKER_OK
exit /b 0
