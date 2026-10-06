#!/bin/sh
# Mac / Linux: launchd (install_mac.sh) gọi file này mỗi 10 phút. run.py tự bỏ qua nếu không có nến mới,
# tự thử lại khi mất mạng và ghi nhật ký vào research/live/log.txt + research/live/history/.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.." || exit 1
PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
exec "$PY" research/live/run.py
