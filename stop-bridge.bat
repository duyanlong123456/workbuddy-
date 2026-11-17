@echo off
chcp 65001 >nul
setlocal
set "PORT=17399"
if not "%WB_BRIDGE_PORT%"=="" set "PORT=%WB_BRIDGE_PORT%"

echo 正在停止 WorkBuddy Bridge (端口 %PORT%) ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"127.0.0.1:%PORT% .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
  echo 已结束进程 %%p
)
echo 完成。
timeout /t 2 >nul
