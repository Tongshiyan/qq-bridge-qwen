@echo off
rem Fallback launcher: no console window, no Qwen控制台.exe needed.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0QwenControlPanel.ps1"
