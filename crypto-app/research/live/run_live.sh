#!/bin/sh
# Mac / Linux: chạy sau mỗi nến 4h (install_mac.sh đăng ký tự động với launchd).
# launchd không nạp PATH của Terminal, nên tự thêm chỗ Homebrew cài node / python.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.." || exit 1
PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
echo "===== $(date)" >> research/live/log.txt
node research/live_export.js >> research/live/log.txt 2>&1
"$PY" research/live.py >> research/live/log.txt 2>&1
