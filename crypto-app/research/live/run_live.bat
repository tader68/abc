@echo off
rem Chay sau moi nen 4h: tai du lieu moi tu Binance roi quet tin hieu, ghi log vao research\live\log.txt
cd /d "%~dp0\..\.."
set PYTHONIOENCODING=utf-8
echo ===== %date% %time% >> research\live\log.txt
node research\live_export.js >> research\live\log.txt 2>&1
python research\live.py >> research\live\log.txt 2>&1
