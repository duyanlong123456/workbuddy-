@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title WorkBuddy Bridge - 自检

set "PORT=17399"
if not "%WB_BRIDGE_PORT%"=="" set "PORT=%WB_BRIDGE_PORT%"

echo ==========================================
echo   WorkBuddy Bridge 环境自检
echo ==========================================
echo.

echo [1/4] Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo      [X] 未找到 node，请安装 Node.js 18+ : https://nodejs.org/
) else (
  for /f "delims=" %%v in ('node -v') do echo      [OK] Node %%v
)

echo.
echo [2/4] WorkBuddy 进程
tasklist /FI "IMAGENAME eq WorkBuddy.exe" 2>nul | find /I "WorkBuddy.exe" >nul
if errorlevel 1 (
  echo      [X] 未运行，请打开并登录 WorkBuddy 桌面版
) else (
  echo      [OK] WorkBuddy 正在运行
)

echo.
echo [3/4] 登录文件
set "AUTH=%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info"
if exist "%AUTH%" (
  echo      [OK] %AUTH%
) else (
  echo      [X] 未找到: %AUTH%
  echo          如安装位置特殊，可设置环境变量 WB_AUTH_FILE 指向该文件
)

echo.
echo [4/4] 桥接服务
powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:%PORT%/health' -UseBasicParsing -TimeoutSec 4; Write-Host ('      [OK] ' + $r.Content) } catch { Write-Host '      [X] 未启动，请运行 start-bridge.bat' }"

echo.
pause
