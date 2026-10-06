#!/usr/bin/env python3
"""Signal bot: 'buy after a sell-off' with the 10-model event ensemble. Run after every 4h candle close.

Each run:
  1. reads the live panel written by live_export.js (last ~1500 closed 4h candles, same features as training)
  2. follows the open positions and tells you when to close them:
       * take-profit +4% reached (your limit order should have filled)
       * time is up (2 days after entry)
       * the median coin fell another 5% since the signal: the dip has turned into a crash
  3. looks for new signals on the candle that just closed: a coin down >= 6% from its 24h high and an
     average win probability >= 90% over the 10 models; up to 10 open positions, strongest first;
     size 10-20% of capital (more for more confident signals)
  4. sends everything to Telegram and keeps a record of every signal so live results can be
     compared with the backtest (state.json)

    python3 research/live.py                 # normal run (after: node research/live_export.js)
    python3 research/live.py --dry-run       # print messages instead of sending them
    python3 research/live.py --replay 300    # replay the last 300 candles with a scratch state (test)
    python3 research/live.py --report        # summary of all recorded trades
"""
import argparse
import datetime as dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import lightgbm as lgb
import numpy as np

from event_features import context, detect, market_index

HERE = Path(__file__).parent
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')  # Windows consoles / log files default to a legacy code page
ap = argparse.ArgumentParser()
ap.add_argument('--panel', default=str(HERE / '.cache/live/panel'))
ap.add_argument('--models', default=str(HERE / 'live/models'))
ap.add_argument('--config', default=str(HERE / 'live/config.json'))
ap.add_argument('--state', default=str(HERE / 'live/state.json'))
ap.add_argument('--dry-run', action='store_true')
ap.add_argument('--replay', type=int, default=0, help='test: step through the last N candles with a scratch state, no Telegram')
ap.add_argument('--report', action='store_true')
ap.add_argument('--asof', type=int, default=0, help='test: pretend the panel ends at this bar index')
args = ap.parse_args()

DEFAULTS = dict(telegram_token='', telegram_chat_id='', capital_usdt=1000, size=0.10, conf_size=1.0, threshold=0.90,
                need_drop=0.06, tp=0.04, hold_bars=12, mkt_exit=0.05, max_open=10, skip_if_above=0.02, tz_hours=7)
cfg = dict(DEFAULTS)
if Path(args.config).exists():
    cfg.update(json.loads(Path(args.config).read_text(encoding='utf-8')))
BAR = 4 * 3600_000
COST = 0.001  # fee + slippage per side, as in the backtest


def vn(ms):
    return (dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc) + dt.timedelta(hours=cfg['tz_hours'])).strftime('%d/%m %H:%M')


def fmt(x):
    return f'{x:.6g}'


def send(lines):
    text = '\n'.join(lines)
    if args.replay:
        return
    print(text + '\n')
    if args.dry_run or not cfg['telegram_token'] or not cfg['telegram_chat_id']:
        return
    data = urllib.parse.urlencode({'chat_id': cfg['telegram_chat_id'], 'text': text}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{cfg['telegram_token']}/sendMessage", data, timeout=30).read()
    except Exception as e:  # noqa: BLE001 - never crash the run because Telegram is down
        print(f'(không gửi được Telegram: {e})')


def load_state(path):
    if path and Path(path).exists():
        return json.loads(Path(path).read_text(encoding='utf-8'))
    return {'last_bar': 0, 'open': [], 'closed': [], 'missed': 0}


def save_state(st, path):
    if path:
        Path(path).write_text(json.dumps(st, indent=1), encoding='utf-8')


def report(st):
    cl = st['closed']
    if not cl:
        return ['Chưa có lệnh nào đóng.']
    r = np.array([c['ret'] for c in cl])
    w = np.array([c['size'] for c in cl])
    months = {}
    for c in cl:
        key = (dt.datetime.fromtimestamp(c['exit_t'] / 1000, dt.timezone.utc) + dt.timedelta(hours=cfg['tz_hours'])).strftime('%m/%Y')
        months.setdefault(key, []).append(c['ret'] * c['size'])
    out = [f'📊 Tổng kết {len(cl)} lệnh đã đóng: thắng {(r > 0).mean() * 100:.0f}% · lãi TB {r.mean() * 100:.2f}%/lệnh · '
           f'cộng dồn ≈ {(r * w).sum() * 100:+.1f}% vốn']
    out += [f'  tháng {m}: {sum(v) * 100:+.1f}% vốn ({len(v)} lệnh)' for m, v in months.items()]
    out.append(f"Đang mở: {len(st['open'])} lệnh · tín hiệu bị lỡ do bot tắt: {st.get('missed', 0)}")
    out.append('Kỳ vọng từ backtest: thắng ~70–90%, lãi TB ~2–3%/lệnh.')
    return out


if args.report:
    print('\n'.join(report(load_state(args.state))))
    raise SystemExit

# ---------- data + models ----------
D = Path(args.panel)
meta = json.loads((D / 'meta.json').read_text())
syms, n, T = meta['symbols'], meta['n'], np.array(meta['t'], dtype=np.int64)
names = meta['features']
C, F = len(syms), len(names)
P = np.stack([np.fromfile(D / f'P_{s}.bin', dtype=np.float64).reshape(n, 5) for s in syms])
O, Hh, L, CL, FUND = (P[:, :, k] for k in range(5))
X = np.stack([np.fromfile(D / f'X_{s}.bin', dtype=np.uint8).reshape(n, F) for s in syms])
if args.asof:
    n = args.asof + 1
    T, P, X = T[:n], P[:, :n], X[:, :n]
    O, Hh, L, CL, FUND = (P[:, :, k] for k in range(5))
mm = json.loads((Path(args.models) / 'meta.json').read_text())
models = [lgb.Booster(model_file=str(f)) for f in sorted(Path(args.models).glob('event_seed*.txt'))]
assert mm['panel_features'] == names, 'live panel features differ from the trained models: rerun live_export.js'
MKT = market_index(CL)
# every feature is causal (rolling windows look back, cross-coin stats are per bar), so computing them once on
# the whole panel gives, at each bar, exactly what was known when that bar closed
DET = detect(Hh, L, CL, 1, mm['event'], mm['bars_per_day'])
CTX = context(DET, CL, FUND, syms, DET['event'], 1, mm['bars_per_day'])


def score(c_idx, i, ctx):
    """Average win probability of the 10 models for coin rows c_idx at bar i."""
    xi = X[c_idx, i, :].astype(np.float32)
    xi[xi == 255] = np.nan
    xc = np.stack([np.asarray(ctx[k])[c_idx, i] for k in mm['context_features']], axis=1).astype(np.float32)
    feats = np.concatenate([xi, xc], axis=1)
    return np.mean([m.predict(feats) for m in models], axis=0)


def step(st, i, live=True):
    """Process the candle i that just closed (all data up to i is known)."""
    det, ctx, k = DET, CTX, i
    msgs = []
    # 1) follow open positions (bars after the last processed one, up to i)
    still = []
    for p in st['open']:
        c = syms.index(p['symbol']) if p['symbol'] in syms else None
        sb = int(np.searchsorted(T, p['signal_t']))
        if c is None or sb >= n or T[sb] != p['signal_t']:
            still.append(p)
            continue
        if p.get('entry') is None and i >= sb + 1:
            p['entry'] = float(O[c, sb + 1]) * (1 + 0.0002)
            p['tp_price'] = p['entry'] * (1 + cfg['tp'])
        done = None
        first = max(sb + 1, p.get('checked', sb) + 1)
        for j in range(first, i + 1):
            if p.get('entry') is None:
                break
            if Hh[c, j] >= p['tp_price']:
                done = (j, max(O[c, j], p['tp_price']) if j > sb + 1 else p['tp_price'], 'tp')
                break
            if j >= sb + 1 + cfg['hold_bars']:
                done = (j, O[c, j], 'time')
                break
            if j - 1 > sb and MKT[j - 1] - MKT[sb] <= np.log(1 - cfg['mkt_exit']):
                done = (j, O[c, j], 'market')
                break
            p['fund'] = p.get('fund', 0.0) + (FUND[c, j] if np.isfinite(FUND[c, j]) else 0.0)
        p['checked'] = i
        # exits decided at the close of bar i: tell the user now, fill at the next open
        quiet = p.get('missed')  # a signal missed while the bot was off: tracked for statistics only
        if done is None and p.get('entry') is not None and not quiet:
            if i + 1 >= sb + 1 + cfg['hold_bars']:
                msgs.append([f"⏰ ĐÓNG LỆNH {p['symbol'][:-4]} NGAY (lệnh market)", f"Đã hết {cfg['hold_bars'] * 4}h giữ lệnh mà chưa chạm chốt lời.",
                             f"Giá hiện tại {fmt(CL[c, i])} · giá vào {fmt(p['entry'])} ({(CL[c, i] / p['entry'] - 1) * 100:+.1f}%)."])
                p['exit_pending'] = 'time'
            elif i > sb and MKT[i] - MKT[sb] <= np.log(1 - cfg['mkt_exit']):
                msgs.append([f"⚠️ ĐÓNG LỆNH {p['symbol'][:-4]} NGAY (lệnh market)", f"Cả thị trường đã rơi thêm {cfg['mkt_exit'] * 100:.0f}% kể từ tín hiệu: cú giảm đang thành sập.",
                             f"Giá hiện tại {fmt(CL[c, i])} · giá vào {fmt(p['entry'])} ({(CL[c, i] / p['entry'] - 1) * 100:+.1f}%)."])
                p['exit_pending'] = 'market'
        if done:
            j, px, why = done
            ret = (px / p['entry'] - 1) - 2 * COST - p.get('fund', 0.0)
            p.update(exit_t=int(T[j]), exit_price=float(px), reason=why, ret=float(ret))
            st['closed'].append(p)
            if quiet:
                pass
            elif why == 'tp':
                msgs.append([f"✅ {p['symbol'][:-4]} đã chạm chốt lời +{cfg['tp'] * 100:.0f}% ({fmt(p['tp_price'])}).",
                             f"Lệnh limit chốt lời của bạn đã khớp. Lãi ≈ {ret * 100:+.2f}% trên lệnh (đã trừ phí)."])
            elif p.get('exit_pending') is None:
                msgs.append([f"ℹ️ {p['symbol'][:-4]} đã đóng theo quy tắc ({'hết giờ' if why == 'time' else 'thị trường sập'}) ở {fmt(px)}: {ret * 100:+.2f}%."])
        else:
            still.append(p)
    st['open'] = still
    # 2) new signals on bar i
    held = {p['symbol'] for p in st['open']}
    cand = np.where(det['event'][:, k] & (det['drop24'][:, k] <= -cfg['need_drop']) & np.isfinite(CL[:, i]))[0]
    cand = [c for c in cand if syms[c] not in held]
    if cand:
        pr = score(np.array(cand), i, ctx)
        order = np.argsort(-pr)
        for o in order:
            c, p = cand[o], float(pr[o])
            if p < cfg['threshold'] or sum(not q.get('missed') for q in st['open']) >= cfg['max_open']:
                continue
            frac = cfg['size'] * (1 + cfg['conf_size'] * (p - cfg['threshold']) / (1 - cfg['threshold']))
            pos = dict(symbol=syms[c], signal_t=int(T[i]), signal_close=float(CL[c, i]), p=p, size=frac, entry=None, checked=i,
                       deadline_t=int(T[i] + BAR * (1 + cfg['hold_bars'])), drop24=float(det['drop24'][c, k]))
            if not live:
                pos['missed'] = True
                st['missed'] = st.get('missed', 0) + 1
            st['open'].append(pos)
            if live:
                usdt = frac * cfg['capital_usdt']
                msgs.append([f"🟢 MUA {syms[c][:-4]} (futures USDT-M, long)",
                             f"Coin vừa rơi {-det['drop24'][c, k] * 100:.1f}% trong 24h · 10 mô hình: xác suất thắng {p * 100:.0f}%",
                             f"• Vào lệnh market ngay: ~{usdt:.0f} USDT (≈{frac * 100:.0f}% vốn), đòn bẩy 2–3x margin cross",
                             f"• Giá lúc tín hiệu: {fmt(CL[c, i])} · BỎ QUA nếu giá đã trên {fmt(CL[c, i] * (1 + cfg['skip_if_above']))}",
                             f"• Đặt ngay lệnh limit chốt lời +{cfg['tp'] * 100:.0f}% so với giá khớp của bạn (≈{fmt(CL[c, i] * (1 + cfg['tp']))})",
                             f"• Không đặt cắt lỗ. Hạn chót đóng lệnh: {vn(pos['deadline_t'])} — bot sẽ nhắc, và báo sớm nếu thị trường sập",
                             f"Đang mở {sum(not q.get('missed') for q in st['open'])}/{cfg['max_open']} lệnh."])
    st['last_bar'] = int(T[i])
    return msgs


if args.replay:
    st = load_state(None)
    for i in range(n - args.replay, n):
        step(st, i)
    print(f'Replay {args.replay} nến ({vn(T[n - args.replay])} → {vn(T[-1] + BAR)}): {len(st["closed"])} lệnh đóng, {len(st["open"])} đang mở')
    for c in st['closed']:
        print(f"  {vn(c['signal_t'])} {c['symbol']:<12} p={c['p']:.2f} vốn {c['size'] * 100:.0f}% → {c['reason']:<6} {c['ret'] * 100:+6.2f}%")
    print('\n'.join(report(st)))
    raise SystemExit

st = load_state(args.state)
i_last = n - 1
age_h = (dt.datetime.now(dt.timezone.utc).timestamp() * 1000 - (T[i_last] + BAR)) / 3.6e6
if age_h > 6 and not args.asof:
    # never act on old candles: a 'buy now' on yesterday's price would be wrong. Keep the state untouched so the
    # bars are processed (as missed signals / exits) once fresh data arrives.
    send([f'⚠️ Dữ liệu cũ: nến đóng gần nhất cách đây {age_h:.0f} giờ. Bot KHÔNG gửi tín hiệu lần này.',
          'Kiểm tra mạng / Binance rồi chạy lại: node research\\live_export.js && python research\\live.py'])
    raise SystemExit(1)
if st['last_bar'] >= T[i_last]:
    print(f'Nến {vn(T[i_last] + BAR)} đã xử lý rồi, không có gì mới.')
    raise SystemExit
# bars missed while the computer was off: replay them for exits / bookkeeping, but do not ask to enter late
start = int(np.searchsorted(T, st['last_bar']) + 1) if st['last_bar'] else i_last
start = max(start, i_last - 6 * 7)
for i in range(start, i_last + 1):
    for m in step(st, i, live=(i == i_last)):
        if i == i_last:
            send(m)
missed_now = [p for p in st['open'] if p.get('missed') and p['signal_t'] > st.get('reported_missed_t', 0)]
if missed_now:
    send([f"ℹ️ Trong lúc bot tắt đã có {len(missed_now)} tín hiệu bị lỡ: " + ', '.join(p['symbol'][:-4] for p in missed_now) + '. Không vào lệnh trễ; bot vẫn ghi lại để so sánh.'])
    st['reported_missed_t'] = max(p['signal_t'] for p in missed_now)
hour_vn = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=cfg['tz_hours'])).hour
if hour_vn in (7, 8):
    send([f"🤖 Bot hoạt động bình thường · {len(st['open'])} lệnh đang mở · {len(st['closed'])} lệnh đã đóng"] + report(st)[:1])
save_state(st, args.state)
print(f'Đã xử lý nến đóng lúc {vn(T[i_last] + BAR)} (giờ VN). Lệnh mở: {len(st["open"])}.')
