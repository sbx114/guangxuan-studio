@echo off
chcp 65001 >nul
call "%~dp0重启Gx.cmd" %*
exit /b %errorlevel%
