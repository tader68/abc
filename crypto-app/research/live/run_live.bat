@echo off
rem Task Scheduler goi file nay moi 10 phut. run.py tu bo qua neu khong co nen moi, tu thu lai khi mat mang.
cd /d "%~dp0\..\.."
set PYTHONIOENCODING=utf-8
python research\live\run.py
