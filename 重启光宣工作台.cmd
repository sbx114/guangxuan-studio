@echo off
chcp 65001 >nul
call "%~dp0启动光宣工作台.cmd" --stop
if errorlevel 1 exit /b 1
timeout /t 2 /nobreak >nul
call "%~dp0启动光宣工作台.cmd"
