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


def cfg_get():
    return json.loads((LIVE / 'config.json').read_text(encoding='utf-8')) if (LIVE / 'config.json').exists() else {}


def report_text(st, cfg, since=0):
    closed = [c for c in st['closed'] if not c.get('missed') and c.get('user') != 'skipped' and c.get('exit_t', 0) >= since]
    real_open = [p for p in st['open'] if not p.get('missed') and p.get('user') != 'skipped']
    if not closed:
        return f'Chưa có lệnh nào đóng{" trong tuần" if since else ""}. Đang mở: {len(real_open)} lệnh.'
    rets = [c['ret'] for c in closed]
    eq = 1.0
    for c in closed:
        eq *= 1 + c['ret'] * c['size']
    return (f"{len(closed)} lệnh đã đóng · thắng {sum(x > 0 for x in rets) / len(rets) * 100:.0f}% · lãi TB {sum(rets) / len(rets) * 100:+.2f}%/lệnh\n"
            f"Tổng trên vốn: {(eq - 1) * 100:+.1f}% ({(eq - 1) * cfg.get('capital_usdt', 1000):+.0f}$) · đang mở: {len(real_open)} lệnh")


def answer_commands(rs):
    """Reply to /baocao, /lenh, /trangthai sent to the bot on Telegram (checked at every 10-minute start)."""
    cfg = cfg_get()
    tok, chat = cfg.get('telegram_token'), str(cfg.get('telegram_chat_id', ''))
    if not tok or not chat:
        return
    api = f'https://api.telegram.org/bot{tok}'
    try:
        if not rs.get('commands_set'):
            cmds = [{'command': 'baocao', 'description': 'Tổng kết lãi/lỗ'}, {'command': 'lenh', 'description': 'Lệnh đang mở'},
                    {'command': 'trangthai', 'description': 'Bot có đang chạy không'}]
            urllib.request.urlopen(api + '/setMyCommands', urllib.parse.urlencode({'commands': json.dumps(cmds, ensure_ascii=False)}).encode(), timeout=20).read()
            rs['commands_set'] = True
        r = json.load(urllib.request.urlopen(f"{api}/getUpdates?timeout=0&offset={rs.get('update_offset', 0)}", timeout=20))
    except Exception:  # noqa: BLE001 - offline: try again next time
        return
    st = json.loads((LIVE / 'state.json').read_text(encoding='utf-8')) if (LIVE / 'state.json').exists() else {'open': [], 'closed': [], 'last_bar': 0}
    changed = False
    for u in r.get('result', []):
        rs['update_offset'] = u['update_id'] + 1
        cq = u.get('callback_query')
        if cq and str(cq.get('message', {}).get('chat', {}).get('id')) == chat:
            # button under a buy signal: remember whether the user really took the trade
            act, sym, t0 = (cq.get('data') or '||').split('|')[:3]
            hit = next((p for p in st['open'] + st['closed'] if p['symbol'] == sym and str(p['signal_t']) == t0), None)
            if hit:
                hit['user'] = 'entered' if act == 'in' else 'skipped'
                changed = True
            note = ('Đã ghi: bạn ĐÃ VÀO ' if act == 'in' else 'Đã ghi: bạn BỎ QUA ') + sym[:-4] + ('' if hit else ' (không tìm thấy lệnh)')
            try:
                urllib.request.urlopen(api + '/answerCallbackQuery', urllib.parse.urlencode({'callback_query_id': cq['id'], 'text': note}).encode(), timeout=20).read()
            except Exception:  # noqa: BLE001
                pass
            telegram('✍️ ' + note + ('. Bot sẽ không nhắc đóng lệnh này nữa.' if act != 'in' else '. Bot sẽ nhắc khi cần đóng.'))
            continue
        msg = u.get('message') or {}
        if str(msg.get('chat', {}).get('id')) != chat:
            continue  # only the owner may ask
        cmd = (msg.get('text') or '').strip().lower().split('@')[0]
        real_open = [p for p in st['open'] if not p.get('missed') and p.get('user') != 'skipped']
        closed = [c for c in st['closed'] if not c.get('missed')]
        if cmd in ('/baocao', 'baocao', 'báo cáo'):
            text = '📊 ' + report_text(st, cfg)
        elif cmd in ('/lenh', 'lenh', 'lệnh'):
            text = '📂 Lệnh đang mở:\n' + '\n'.join(
                f"• {p['symbol'][:-4]}: vào {p.get('entry') or p.get('signal_close'):.6g}, chốt lời {(p.get('tp_price') or (p.get('entry') or p['signal_close']) * 1.04):.6g}, hạn {vn(p['deadline_t'] / 1000)}"
                for p in real_open) if real_open else '📂 Không có lệnh nào đang mở.'
        elif cmd in ('/trangthai', 'trangthai', 'trạng thái', '/start', '/help'):
            age = (now() - st['last_bar'] / 1000 - BAR) / 3600 if st.get('last_bar') else None
            text = ('🤖 Bot đang chạy bình thường' if age is not None and age <= 4.5 else '⚠️ Bot đang trễ / chưa chạy được') + \
                   (f"\nNến xử lý gần nhất: {vn(st['last_bar'] / 1000 + BAR)} · lần chạy OK gần nhất: {vn(rs.get('last_ok', now()))}" if st.get('last_bar') else '') + \
                   '\nLệnh: /baocao (lãi/lỗ) · /lenh (lệnh đang mở) · /trangthai'
        else:
            continue
        telegram(text)
    if changed:
        (LIVE / 'state.json').write_text(json.dumps(st, indent=1), encoding='utf-8')
    # weekly summary: Sunday evening (Vietnam time), once per week
    vn_now = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=7)
    week = vn_now.strftime('%G-%V')
    if vn_now.weekday() == 6 and vn_now.hour >= 20 and rs.get('weekly_sent') != week:
        if telegram('🗓 Tổng kết tuần\n' + report_text(st, cfg, since=(now() - 7 * 86400) * 1000) + '\n\nTừ đầu: ' + report_text(st, cfg)):
            rs['weekly_sent'] = week


def refresh_dashboard():
    try:
        sys.path.insert(0, str(LIVE))
        import dashboard  # noqa: PLC0415 - optional, never break the run
        dashboard.build()
    except Exception as e:  # noqa: BLE001
        log(f'(không tạo được dashboard: {e})')


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
    answer_commands(rs)
    if last_bar >= expected_ms:
        if (LIVE / 'outbox.json').exists():  # messages that failed earlier: try again now
            run([PY, 'research/live.py', '--flush-only'], 120)
        HIST.mkdir(parents=True, exist_ok=True)
        RUNNER.write_text(json.dumps(rs), encoding='utf-8')
        refresh_dashboard()
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
        rs.update(last_ok=now(), alerted=False)
    else:
        tail = '\n'.join(out.strip().splitlines()[-5:])
        record({'type': 'fail', 'step': step, 'rc': rc, 'error': tail[-800:]})
        down_h = (now() - rs.get('last_ok', now())) / 3600
        if down_h > 12 and not rs.get('alerted'):
            rs['alerted'] = telegram(f'⚠️ Bot chưa chạy được {down_h:.0f} giờ (mất mạng hoặc Binance lỗi). Bot tự thử lại mỗi 10 phút.\nLỗi gần nhất: {tail[-300:]}')
    HIST.mkdir(parents=True, exist_ok=True)
    RUNNER.write_text(json.dumps(rs), encoding='utf-8')
    refresh_dashboard()
finally:
    shutil.rmtree(LOCK, ignore_errors=True)
