@echo off
rem Huan luyen lai 10 mo hinh voi du lieu moi nhat (nen chay moi thang). Lan dau tai du lieu kha lau (1-2 gio).
cd /d "%~dp0\..\.."
set PYTHONIOENCODING=utf-8
node research\mlexport2.js
for %%s in (0 3 7 20 21 22 23 24 25 26) do python research\ml_event.py --seed %%s --final research\live\models
echo Xong. Mo hinh moi da luu trong research\live\models
pause
