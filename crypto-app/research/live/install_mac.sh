#!/bin/sh
# Cài bot trên Mac: môi trường Python riêng + launchd gọi bot mỗi 10 phút (bot chỉ làm việc khi có nến 4h mới).
#   sh research/live/install_mac.sh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
APP="$(pwd)"
echo "Thư mục app: $APP"
command -v node >/dev/null || { echo "Thiếu Node.js: chạy  brew install node"; exit 1; }
command -v python3 >/dev/null || { echo "Thiếu Python: chạy  brew install python"; exit 1; }
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet numpy lightgbm
.venv/bin/python -c "import lightgbm" || { echo "LightGBM chưa chạy được: chạy  brew install libomp  rồi chạy lại script này"; exit 1; }
chmod +x research/live/run_live.sh
PLIST="$HOME/Library/LaunchAgents/com.abc.signalbot.plist"
mkdir -p "$HOME/Library/LaunchAgents"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo '  <key>Label</key><string>com.abc.signalbot</string>'
  echo "  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$APP/research/live/run_live.sh</string></array>"
  echo '  <key>RunAtLoad</key><true/>'
  echo '  <key>StartInterval</key><integer>600</integer>'
  echo '</dict></plist>'
} > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
.venv/bin/python research/live/dashboard.py >/dev/null 2>&1 || true
ln -sf "$APP/research/live/dashboard.html" "$HOME/Desktop/Bot tín hiệu.html"
echo "Đã tạo lối tắt trên Desktop: 'Bot tín hiệu.html' (nhấp đúp để xem tình trạng bot, lệnh đang mở, lãi/lỗ)."
echo "Xong. Bot kiểm tra mỗi 10 phút: có nến 4h mới thì quét tín hiệu, mất mạng thì tự thử lại, và chạy bù khi Mac thức dậy."
echo "Nhật ký: $APP/research/live/log.txt   ·   Gỡ bot: launchctl unload $PLIST"
