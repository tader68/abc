#!/usr/bin/env python3
"""Improve the ML 'confident buy after a sell-off' strategy without fooling ourselves.

Uses the walk-forward predictions saved by ml_model.py (--save) on the 2021+ panel.
Event-driven engine: every 4h bar, a coin whose prediction clears the threshold opens a position at
the next bar's open (if not already held), sized at 10% of equity, at most 10 open; exit after H bars
or at take-profit / stop-loss (checked on highs/lows, stop first); fees + slippage + funding.

Variants are SELECTED on 2022-02..2024-12 and then CHECKED once on 2025-01..now.

    python3 research/ml_improve.py --pred path/to/panel_pred.npz [--dir research/.cache/ml/panel_4h]
"""
import argparse
import itertools
import json
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default=str(Path(__file__).parent / '.cache/ml/panel_4h'))
ap.add_argument('--pred', required=True)
ap.add_argument('--out', default='ml-improve-results.json')
ap.add_argument('--only', help='evaluate one variant: thr,H,tp,sl,need,uni (e.g. 0.25,12,0.04,0,0.06,20)')
ap.add_argument('--context', action='store_true', help='with --only: split trades by macro context (needs macro.npz)')
ap.add_argument('--cost', type=float, default=0.001, help='fee + slippage per side (0.001 = 0.1%%)')
ap.add_argument('--show-trades', action='store_true', help='with --only: list best/worst trades and per-coin stats')
ap.add_argument('--size', type=float, default=0.1, help='fraction of equity per position')
ap.add_argument('--side', default='long', choices=['long', 'short'], help='short: sell after a pump instead of buying after a drop')
ap.add_argument('--thr-mode', default='centered', choices=['centered', 'abs'],
                help='centered: |p - 0.5| >= thr in the trade direction (general model); abs: p >= thr (event model win probability)')
ap.add_argument('--thr-list', default='', help='comma list of thresholds for the grid (default 0.2,0.25,0.3; abs mode 0.5,0.55,0.6,0.65,0.7)')
args = ap.parse_args()

D = Path(args.dir)
meta = json.loads((D / 'meta.json').read_text())
syms, n = meta['symbols'], meta['n']
t = np.array(meta['t'], dtype=np.int64)
C = len(syms)
P = np.stack([np.fromfile(D / f'P_{s}.bin', dtype=np.float64).reshape(n, 5) for s in syms])
O, Hh, L, CL, FUND = (P[:, :, k] for k in range(5))
p_dir = np.load(args.pred)['p_dir']
SPLIT = np.datetime64('2025-01-01').astype('datetime64[ms]').astype(np.int64)
COST = args.cost  # fee + slippage per side
MAJ12 = 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,TRXUSDT,DOTUSDT'.split(',')
MAJ20 = MAJ12 + 'BCHUSDT,ATOMUSDT,NEARUSDT,UNIUSDT,ETCUSDT,FILUSDT,APTUSDT,OPUSDT'.split(',')

# coin drawdown from its 24h (6-bar) high, known at the close of each bar
hi6 = np.full((C, n), np.nan)
for k in range(6, n):
    hi6[:, k] = np.nanmax(Hh[:, k - 6 : k + 1], axis=1)
drop24 = CL / hi6 - 1
lo6 = np.full((C, n), np.nan)
for k in range(6, n):
    lo6[:, k] = np.nanmin(L[:, k - 6 : k + 1], axis=1)
rise24 = CL / lo6 - 1
SIDE = 1 if args.side == 'long' else -1


trade_bars = []
trade_log = []
_last_trades = []


def run(thr, H, tp, sl, need_drop, universe, from_t, to_t):
    tradable = np.array([s in universe for s in syms])
    eq, peak, mdd = 1.0, 1.0, 0.0
    open_pos = {}  # coin -> dict(entry, exit_bar, size)
    trades = []
    trade_bars.clear()
    trade_log.clear()
    curve = []
    for i in range(1, n - 1):
        if t[i] < from_t or t[i] >= to_t:
            continue
        # 1) manage open positions during bar i
        for c in list(open_pos):
            p = open_pos[c]
            px = None
            e = p['entry']
            if SIDE > 0 and sl and L[c, i] <= e * (1 - sl):
                px = min(O[c, i], e * (1 - sl))
            elif SIDE < 0 and sl and Hh[c, i] >= e * (1 + sl):
                px = max(O[c, i], e * (1 + sl))
            elif SIDE > 0 and tp and Hh[c, i] >= e * (1 + tp):
                px = max(O[c, i], e * (1 + tp))
            elif SIDE < 0 and tp and L[c, i] <= e * (1 - tp):
                px = min(O[c, i], e * (1 - tp))
            elif i >= p['exit_bar']:
                px = O[c, i]
            if px is not None and np.isfinite(px):
                r = SIDE * (px / p['entry'] - 1) - 2 * COST - SIDE * p['fund']
                eq += p['size'] * r
                trades.append(r)
                trade_bars.append(p['bar'])
                trade_log.append((syms[c], str(np.datetime64(int(t[p['bar']]), 'ms'))[:16], r))
                del open_pos[c]
            else:
                if np.isfinite(FUND[c, i]):
                    p['fund'] += FUND[c, i]
        # 2) new signals at the close of bar i -> enter at the open of bar i+1
        pr = p_dir[:, i]
        edge = pr if args.thr_mode == 'abs' else SIDE * (pr - 0.5)
        ok = tradable & np.isfinite(pr) & (edge >= thr) & np.isfinite(O[:, i + 1])
        if need_drop:
            ok &= (drop24[:, i] <= -need_drop) if SIDE > 0 else (rise24[:, i] >= need_drop)
        for c in np.where(ok)[0]:
            if c in open_pos or len(open_pos) >= max(1, int(round(1 / args.size))):
                continue
            open_pos[c] = dict(entry=O[c, i + 1] * (1 + SIDE * 0.0002), exit_bar=i + 1 + H, size=args.size * eq, fund=0.0, bar=i)
        peak = max(peak, eq)
        mdd = max(mdd, 1 - eq / peak)
        curve.append((t[i], eq))
    yrs = (to_t - from_t) / (365.25 * 86400e3)
    tr = np.array(trades)
    _last_trades[:] = trades
    tstat = tr.mean() / tr.std() * np.sqrt(len(tr)) if len(tr) > 2 and tr.std() > 0 else 0.0
    return dict(cagr=(eq ** (1 / yrs) - 1) * 100 if eq > 0 else -100, mdd=mdd * 100, n=len(tr), win=(tr > 0).mean() * 100 if len(tr) else 0,
                mean=tr.mean() * 100 if len(tr) else 0, t=tstat, curve=curve)


start = t[np.argmax(np.isfinite(p_dir).any(axis=0))]
end = t[-1]
if args.only:
    thr, H, tp, sl, need, uni = args.only.split(',')
    universe = MAJ12 if uni == '12' else MAJ20
    for name, a, b in [('chọn 2022–2024', start, SPLIT), ('kiểm tra 2025–nay', SPLIT, end + 1)]:
        r = run(float(thr), int(H), float(tp), float(sl), float(need), universe, a, b)
        cv = r['curve']
        yrs = {}
        for tt, e in cv:
            yrs.setdefault(str(np.datetime64(int(tt), 'ms'))[:4], []).append(e)
        prev = 1.0
        ys = []
        for y_, es in yrs.items():
            ys.append(f"{y_} {(es[-1] / prev - 1) * 100:+.0f}%")
            prev = es[-1]
        print(f"{name}: {r['cagr']:6.1f}%/năm · sụt {r['mdd']:4.1f}% · {r['n']} lệnh · thắng {r['win']:.0f}% · TB {r['mean']:.2f}%/lệnh · t={r['t']:.1f}")
        print('      theo năm: ' + ' · '.join(ys))
        if args.show_trades:
            lg = sorted(trade_log, key=lambda x: x[2])
            print('      tệ nhất: ' + ', '.join(f'{a} {b} {r * 100:+.1f}%' for a, b, r in lg[:6]))
            print('      tốt nhất: ' + ', '.join(f'{a} {b} {r * 100:+.1f}%' for a, b, r in lg[-6:]))
            by = {}
            for a, _, r in trade_log:
                by.setdefault(a, []).append(r)
            print('      theo coin: ' + ', '.join(f'{a[:-4]} {len(v)}×{np.mean(v) * 100:+.1f}%' for a, v in sorted(by.items(), key=lambda kv: -len(kv[1]))))
        if args.context:
            mz = np.load(D / 'macro.npz')
            M, mn = mz['M'], list(mz['names'])
            col = lambda k: M[np.array(trade_bars), mn.index(k)]  # noqa: E731
            tr = np.array(_last_trades)
            conds = {
                'chứng khoán Mỹ giảm >3% trong 5 ngày': col('spx_ret5') < -0.03,
                'VIX > 25 (thị trường truyền thống sợ hãi)': col('vix') > 25,
                'trong 2 ngày sau khi Fed họp': col('post_fomc_48h') > 0,
                'cuối tuần (chứng khoán Mỹ đóng cửa)': col('weekend') > 0,
                'đám đông chú ý cao (lượt xem Wikipedia BTC z>1)': col('wiki_btc_z30') > 1,
                'đô la mạnh lên >1% trong 5 ngày': col('dxy_ret5') > 0.01,
            }
            for label, m in conds.items():
                m = np.nan_to_num(m.astype(float)) > 0
                for flag, sel in [('CÓ', m), ('KHÔNG', ~m)]:
                    x = tr[sel]
                    if len(x) >= 5:
                        print(f"      {label} = {flag:5s}: {len(x):4d} lệnh · thắng {(x > 0).mean() * 100:3.0f}% · TB {x.mean() * 100:5.2f}%/lệnh")
    raise SystemExit
THRS = [float(x) for x in args.thr_list.split(',')] if args.thr_list else ([0.5, 0.55, 0.6, 0.65, 0.7] if args.thr_mode == 'abs' else [0.2, 0.25, 0.3])
grid = list(itertools.product(THRS, [6, 12, 18], [0, 0.04, 0.08], [0, 0.08], [0, 0.06], ['12', '20']))
print(f'Thử {len(grid)} biến thể · CHỌN trên {np.datetime64(int(start), "ms")!s:.10} → 2024-12-31 · KIỂM TRA trên 2025-01-01 → {np.datetime64(int(end), "ms")!s:.10}\n')
rows = []
for thr, H, tp, sl, need, uni in grid:
    universe = MAJ12 if uni == '12' else MAJ20
    a = run(thr, H, tp, sl, need, universe, start, SPLIT)
    rows.append(dict(thr=thr, H=H, tp=tp, sl=sl, need=need, uni=uni, dev=a))

def label(r):
    thr = f"xác suất thắng ≥{r['thr'] * 100:.0f}%" if args.thr_mode == 'abs' else f"ngưỡng {r['thr'] * 100:.0f}%"
    mv = 'rơi' if SIDE > 0 else 'tăng'
    return (('SHORT · ' if SIDE < 0 else '') + f"{thr} · giữ {r['H'] // 6} ngày · " + (f"chốt lời +{r['tp'] * 100:.0f}%" if r['tp'] else 'không chốt sớm') + ' · ' +
            (f"cắt lỗ −{r['sl'] * 100:.0f}%" if r['sl'] else 'không cắt lỗ') + ' · ' + (f"coin phải {mv} ≥{r['need'] * 100:.0f}% trong 24h" if r['need'] else f'không cần điều kiện {mv}') +
            f" · {r['uni']} coin")

baseline = next(r for r in rows if r['thr'] == THRS[len(THRS) // 2] and r['H'] == 6 and not r['tp'] and not r['sl'] and not r['need'] and r['uni'] == '12')
ranked = sorted([r for r in rows if r['dev']['n'] >= 40], key=lambda r: -r['dev']['cagr'] / max(r['dev']['mdd'], 5))
print('GỐC (như bản trước, nhưng chấm điểm mỗi 4h):')
for r in [baseline] + ranked[:5]:
    r['final'] = run(r['thr'], r['H'], r['tp'], r['sl'], r['need'], MAJ12 if r['uni'] == '12' else MAJ20, SPLIT, end + 1)
for k, r in enumerate([baseline] + ranked[:5]):
    if k == 1:
        print('\n5 BIẾN THỂ TỐT NHẤT Ở GIAI ĐOẠN CHỌN (lợi nhuận/rủi ro) → KIỂM TRA:')
    d, f = r['dev'], r['final']
    print(f" • {label(r)}")
    print(f"     chọn  2022–2024: {d['cagr']:6.1f}%/năm · sụt {d['mdd']:4.1f}% · {d['n']:4d} lệnh · thắng {d['win']:.0f}% · TB {d['mean']:.2f}%/lệnh · t={d['t']:.1f}")
    print(f"     kiểm tra 2025–nay: {f['cagr']:6.1f}%/năm · sụt {f['mdd']:4.1f}% · {f['n']:4d} lệnh · thắng {f['win']:.0f}% · TB {f['mean']:.2f}%/lệnh · t={f['t']:.1f}")

# how many variants beat the baseline in both periods (robustness map)
for r in rows:
    r.setdefault('final', None)
better_dev = [r for r in rows if r['dev']['cagr'] > baseline['dev']['cagr'] and r['dev']['n'] >= 40]
print(f"\nSố biến thể tốt hơn bản gốc ở giai đoạn chọn: {len(better_dev)}/{len(rows)}")
json.dump({'baseline': {k: v for k, v in baseline.items() if k not in ('dev', 'final')},
           'top': [{'rule': label(r), 'dev': {k: v for k, v in r['dev'].items() if k != 'curve'}, 'final': {k: v for k, v in r['final'].items() if k != 'curve'}} for r in ranked[:5]]},
          open(args.out, 'w'), indent=1, default=float)
print(f'Đã lưu: {args.out}')
