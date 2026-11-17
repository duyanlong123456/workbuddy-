@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title WorkBuddy Bridge

echo ==========================================
echo   WorkBuddy Bridge
echo ==========================================
echo.

rem ---- locate node.exe ----
set "NODE="
if exist "D:\Program Files\nodejs\node.exe" set "NODE=D:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
)
if not defined NODE (
  echo [错误] 找不到 node.exe
  echo 请安装 Node.js 18 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo [OK] Node: %NODE%

set "PORT=17399"
if not "%WB_BRIDGE_PORT%"=="" set "PORT=%WB_BRIDGE_PORT%"

rem ---- already running? ----
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo [OK] 桥接已在运行，端口 %PORT%
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:%PORT%/health' -UseBasicParsing -TimeoutSec 4; Write-Host ('     ' + $r.Content) } catch { Write-Host '     (健康检查失败)' }"
  echo.
  pause
  exit /b 0
)

rem ---- WorkBuddy running? ----
tasklist /FI "IMAGENAME eq WorkBuddy.exe" 2>nul | find /I "WorkBuddy.exe" >nul
if errorlevel 1 (
  echo [提示] 未检测到 WorkBuddy.exe 正在运行。
  echo        桥接需要读取 WorkBuddy 的登录态，请先打开并登录 WorkBuddy 桌面版。
  echo.
)

echo 正在启动桥接，端口 %PORT% ...
start "wb-bridge" /min "%NODE%" "%~dp0server.mjs"
timeout /t 3 >nul

powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 10;$i++){ try { $r=Invoke-WebRequest 'http://127.0.0.1:%PORT%/health' -UseBasicParsing -TimeoutSec 2; Write-Host ('[OK] 桥接运行中: ' + $r.Content); $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if(-not $ok){ Write-Host '[失败] 端口未监听，请查看本窗口上方错误信息'; exit 1 }"

echo.
echo 接口地址（OpenAI 兼容）：
echo   http://127.0.0.1:%PORT%/v1
echo.
echo 关闭：直接关掉弹出的 wb-bridge 窗口，或运行 stop-bridge.bat
echo.
pause
