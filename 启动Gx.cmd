@echo off
chcp 65001 >nul
setlocal
title Gx
set "GX_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined GX_NODE set "GX_NODE=%%N"
if not defined GX_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "GX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined GX_NODE (
  echo 未找到 Node.js。请安装 Node.js 24 或更新版本后重新打开。
  pause
  exit /b 1
)
set "GX_ENTRY=%~dp0scripts\start-local.mjs"
if not exist "%GX_ENTRY%" set "GX_ENTRY=%~dp0resources\app\scripts\start-local.mjs"
if not exist "%GX_ENTRY%" (
  echo 应用文件不完整，请先解压整个应用文件夹。
  pause
  exit /b 1
)
"%GX_NODE%" "%GX_ENTRY%" %*
set "GX_EXIT=%errorlevel%"
if not "%GX_EXIT%"=="0" pause
endlocal & exit /b %GX_EXIT%
