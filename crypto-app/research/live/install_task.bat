@echo off
rem Dang ky bot chay tu dong moi 4 gio (03:05, 07:05, 11:05, 15:05, 19:05, 23:05 gio Viet Nam) va moi khi mo may
schtasks /Create /F /TN "CryptoSignalBot" /SC HOURLY /MO 4 /ST 03:05 /TR "\"%~dp0run_live.bat\""
schtasks /Create /F /TN "CryptoSignalBotLogon" /SC ONLOGON /DELAY 0002:00 /TR "\"%~dp0run_live.bat\""
echo Da dang ky xong. Kiem tra trong Task Scheduler (Trinh lap lich tac vu).
pause
