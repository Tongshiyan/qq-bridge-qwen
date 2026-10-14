@echo off
title Qwen3.8-27B SSH tunnel - close this window to STOP
chcp 65001 >nul 2>&1
echo ============================================================
echo   Qwen3.8-27B SSH tunnel   (VISIBLE window)
echo.
echo   local 127.0.0.1:8000  ==^>  user@your-server-ip (127.0.0.1:8000)
echo.
echo   * Keep this window open while you use the model.
echo   * Close this window to STOP the tunnel.
echo   * Every connect / drop is printed below, with timestamps.
echo   * Compression (-C) is ON: this PC's uplink is only a few
echo     KB/s, and DSH re-uploads the whole context each step.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1"
echo.
echo ------------------------------------------------------------
echo Tunnel keeper exited. Press any key to close this window.
pause >nul
