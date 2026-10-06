#!/bin/sh
# Mac / Linux: chạy sau mỗi nến 4h. Cron (giờ máy là giờ Việt Nam): 5 3,7,11,15,19,23 * * * /đường/dẫn/run_live.sh
cd "$(dirname "$0")/../.." || exit 1
echo "===== $(date)" >> research/live/log.txt
node research/live_export.js >> research/live/log.txt 2>&1
python3 research/live.py >> research/live/log.txt 2>&1
