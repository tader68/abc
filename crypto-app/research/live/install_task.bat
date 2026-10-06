@echo off
rem Dang ky bot: kiem tra moi 10 phut (chi lam viec khi co nen 4h moi, tu thu lai khi mat mang) va khi dang nhap
schtasks /Create /F /TN "CryptoSignalBot" /SC MINUTE /MO 10 /TR "\"%~dp0run_live.bat\""
schtasks /Create /F /TN "CryptoSignalBotLogon" /SC ONLOGON /DELAY 0002:00 /TR "\"%~dp0run_live.bat\""
echo Da dang ky xong. Kiem tra trong Task Scheduler (Trinh lap lich tac vu).
pause
