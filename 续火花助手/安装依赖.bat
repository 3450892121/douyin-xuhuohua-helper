@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在安装依赖（npmmirror 镜像，Electron 二进制约 100MB 请耐心等待）...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
call npm.cmd install --registry=https://registry.npmmirror.com
echo.
if not exist node_modules\electron\dist\electron.exe (
  echo electron 二进制未下载成功，手动补齐：
  echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo   node node_modules\electron\install.js
)
echo.
echo 安装完成。双击「启动续火花助手.bat」开始使用。
pause
