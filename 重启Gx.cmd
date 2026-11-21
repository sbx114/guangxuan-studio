@echo off
chcp 65001 >nul
call "%~dp0启动Gx.cmd" --stop
if errorlevel 1 exit /b 1
timeout /t 2 /nobreak >nul
call "%~dp0启动Gx.cmd"
