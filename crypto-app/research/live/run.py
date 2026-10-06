#!/usr/bin/env python3
"""Runner for the signal bot, started every 10 minutes by launchd (Mac) / Task Scheduler (Windows).

  * does nothing (in a second) when the latest closed 4h candle was already processed
  * otherwise downloads fresh data (live_export.js) and runs live.py
  * if that fails (no network, Binance down), it simply tries again at the next 10-minute start, so the
    bot catches up by itself as soon as the connection is back; Telegram messages that could not be sent
    are kept and resent by live.py
  * every attempt is recorded in research/live/history/runs.jsonl (successes are written by live.py with
    every candidate the models scored; failures here with the error), for later analysis
  * after 12 hours without a successful run it sends one Telegram alert (when Telegram is reachable),
    and one 'back online' message when it recovers
  * keeps research/live/log.txt under ~5 MB (older part moved to log.old.txt)

    python3 research/live/run.py
"""
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LIVE = Path(__file__).resolve().parent
APP = LIVE.parent.parent
LOG = LIVE / 'log.txt'
HIST = LIVE / 'history'
RUNNER = HIST / 'runner.json'
LOCK = LIVE / '.lock'
BAR = 4 * 3600
PY = sys.executable
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PATH'] = os.pathsep.join(['/opt/homebrew/bin', '/usr/local/bin', os.environ.get('PATH', '')])


def now():
    return time.time()


def vn(ts):
    return (dt.datetime.fromtimestamp(ts, dt.timezone.utc) + dt.timedelta(hours=7)).strftime('%d/%m %H:%M')


def log(text):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(text.rstrip() + '\n')


def record(entry):
    HIST.mkdir(parents=True, exist_ok=True)
    with open(HIST / 'runs.jsonl', 'a', encoding='utf-8') as f:
        f.write(json.dumps({'run_at': vn(now()), **entry}, ensure_ascii=False) + '\n')


def telegram(text):
    cfg_file = LIVE / 'config.json'
    if not cfg_file.exists():
        return False
    cfg = json.loads(cfg_file.read_text(encoding='utf-8'))
    if not cfg.get('telegram_token') or not cfg.get('telegram_chat_id'):
        return False
    try:
        data = urllib.parse.urlencode({'chat_id': cfg['telegram_chat_id'], 'text': text}).encode()
        urllib.request.urlopen(f"https://api.telegram.org/bot{cfg['telegram_token']}/sendMessage", data, timeout=20).read()
        return True
    except Exception:  # noqa: BLE001 - offline
        return False


def run(cmd, timeout):
    try:
        p = subprocess.run(cmd, cwd=APP, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
        out = (p.stdout or '') + (p.stderr or '')
        return p.returncode, out
    except subprocess.TimeoutExpired:
        return 124, f'quá thời gian {timeout}s'
    except FileNotFoundError as e:
        return 127, str(e)


# ---------- one runner at a time ----------
try:
    LOCK.mkdir()
except FileExistsError:
    if now() - LOCK.stat().st_mtime < 3600:
        sys.exit(0)  # a previous run is still working
    shutil.rmtree(LOCK, ignore_errors=True)  # left over from a crash
    LOCK.mkdir()
try:
    if LOG.exists() and LOG.stat().st_size > 5_000_000:
        LOG.replace(LIVE / 'log.old.txt')
    rs = json.loads(RUNNER.read_text(encoding='utf-8')) if RUNNER.exists() else {'last_ok': now(), 'alerted': False}
    # open time of the last 4h candle that has closed (with a 1-minute margin for Binance to publish it)
    expected_ms = (int((now() - 60) // BAR) * BAR - BAR) * 1000
    state_file = LIVE / 'state.json'
    last_bar = json.loads(state_file.read_text(encoding='utf-8')).get('last_bar', 0) if state_file.exists() else 0
    if last_bar >= expected_ms:
        if (LIVE / 'outbox.json').exists():  # messages that failed earlier: try again now
            run([PY, 'research/live.py', '--flush-only'], 120)
        sys.exit(0)

    log(f'===== {vn(now())} (giờ VN)')
    rc, out = run(['node', 'research/live_export.js'], 900)
    log(out)
    step = 'live_export'
    if rc == 0:
        rc, out = run([PY, 'research/live.py'], 600)
        log(out)
        step = 'live.py'
    ok = rc == 0
    if ok:
        if rs.get('alerted') or now() - rs.get('last_ok', now()) > 12 * 3600:
            telegram(f"✅ Bot đã chạy lại bình thường (lần chạy thành công trước: {vn(rs['last_ok'])}). Các tín hiệu trong lúc mất kết nối được ghi là 'bị lỡ'.")
        rs = {'last_ok': now(), 'alerted': False}
    else:
        tail = '\n'.join(out.strip().splitlines()[-5:])
        record({'type': 'fail', 'step': step, 'rc': rc, 'error': tail[-800:]})
        down_h = (now() - rs.get('last_ok', now())) / 3600
        if down_h > 12 and not rs.get('alerted'):
            rs['alerted'] = telegram(f'⚠️ Bot chưa chạy được {down_h:.0f} giờ (mất mạng hoặc Binance lỗi). Bot tự thử lại mỗi 10 phút.\nLỗi gần nhất: {tail[-300:]}')
    HIST.mkdir(parents=True, exist_ok=True)
    RUNNER.write_text(json.dumps(rs), encoding='utf-8')
finally:
    shutil.rmtree(LOCK, ignore_errors=True)
