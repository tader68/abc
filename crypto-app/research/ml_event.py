#!/usr/bin/env python3
"""Event model: a LightGBM trained ONLY on sell-off (or pump) moments, scoring the actual trade.

The general model (ml_model.py) learns from every bar of every coin and is right ~52% of the time.
Its only usable edge showed up after sharp sell-offs. This model specialises on those moments:

  * samples  = coin/bar where the coin is down >= --event from its 24h high (or up, for --side short)
  * target   = did the trade we would actually take make money? (enter next open, take profit at
               --tp, otherwise exit after --hold bars; fees, slippage and funding included)
  * features = the 236-indicator library + cross-coin ranks + event context: drop size and speed,
               drop measured in the coin's own volatility, BTC's and the median coin's move,
               how many coins are falling together (capitulation breadth), funding, days since the
               coin's last event
  * walk-forward: retrain every month on past events only (purge gap), predict the next month

Saves p_dir = predicted probability that the trade wins (NaN outside events), in the same format
ml_improve.py reads (use --thr-mode abs, and --side short for the pump model).

    python3 research/ml_event.py --save pred_event.npz [--side long|short] [--event 0.05]
"""
import argparse
import json
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

from event_features import context, detect

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default=str(Path(__file__).parent / '.cache/ml/panel_4h'))
ap.add_argument('--side', default='long', choices=['long', 'short'])
ap.add_argument('--event', type=float, default=0.05, help='minimum 24h move that defines an event')
ap.add_argument('--event-type', default='drop', choices=['drop', 'any'],
                help='drop: 24h move only; any: also extreme funding, open-interest flush/surge, volume spike against the move')
ap.add_argument('--target', default='win', choices=['win', 'ret'], help='win: classify profitable trade; ret: regress the trade return')
ap.add_argument('--tp', type=float, default=0.04, help='take-profit used to label the trade')
ap.add_argument('--hold', type=int, default=12, help='maximum holding period in bars used to label the trade')
ap.add_argument('--train-months', type=int, default=12)
ap.add_argument('--context-only', action='store_true', help='use only the event-context features (ablation)')
ap.add_argument('--placebo', action='store_true', help='shuffle labels across events: results must collapse')
ap.add_argument('--bars-per-day', type=int, default=6, help='6 for 4h candles, 24 for 1h')
ap.add_argument('--subsample', type=int, default=1, help='train on every k-th event (consecutive 1h events are near-duplicates)')
ap.add_argument('--ext', action='store_true', help='add premium index, Coinbase premium, DVOL, BTC order book and stablecoin features from <dir>/ext.npz')
ap.add_argument('--ext-drop', default='', help='comma list of ext feature names to leave out (e.g. slow regime variables)')
ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--save', help='walk-forward predictions file (research mode)')
ap.add_argument('--final', help='train ONE model on every event so far and save it in this folder (for the live bot)')
args = ap.parse_args()

D = Path(args.dir)
meta = json.loads((D / 'meta.json').read_text())
names, syms, n = meta['features'], meta['symbols'], meta['n']
t = np.array(meta['t'], dtype=np.int64)
C, F = len(syms), len(names)
S = 1 if args.side == 'long' else -1
COST = 0.0005 + 0.0005  # per side
P = np.stack([np.fromfile(D / f'P_{s}.bin', dtype=np.float64).reshape(n, 5) for s in syms])
O, Hh, L, CL, FUND = (P[:, :, k] for k in range(5))


BPD = args.bars_per_day
K8 = max(1, BPD // 3)  # bars in 8 hours
det = detect(Hh, L, CL, S, args.event, BPD)
event = det['event']


def xcol(nm):
    out = np.full((C, n), np.nan, dtype=np.float32)
    k = names.index(nm)
    for c in range(C):
        v = np.memmap(D / f'X_{syms[c]}.bin', dtype=np.uint8, mode='r', shape=(n, F))[:, k].astype(np.float32)
        v[v == 255] = np.nan
        out[c] = v
    return out


kinds = {'ev_move': event.copy()}
if args.event_type == 'any':
    fr, oi, vz = xcol('fundRate'), xcol('oiChg6'), xcol('volZ20')
    r2 = np.full_like(CL, np.nan)
    r2[:, K8:] = CL[:, K8:] / CL[:, :-K8] - 1
    with np.errstate(invalid='ignore'):
        kinds['ev_funding'] = (fr <= 2) if S > 0 else (fr >= 98)  # crowd paying heavily to be short (long side) / long
        kinds['ev_oi_flush'] = (oi <= 2) & (S * r2 < 0)  # open interest collapsing while price moves against: liquidations
        kinds['ev_oi_surge'] = (oi >= 98) & (S * r2 < 0)  # new positions piling in against the move
        kinds['ev_vol_spike'] = (vz >= 98) & (S * r2 <= -0.02)  # capitulation volume
    for k, v in kinds.items():
        event |= v
event &= np.isfinite(O[:, np.r_[1:n, n - 1]])

# --- event context features (all known at the close of bar i) ---
ctx = context(det, CL, FUND, syms, event, S, BPD)
if args.event_type == 'any':
    ctx.update({k: v.astype(np.float32) for k, v in kinds.items()})
ctx_names = list(ctx)

# --- trade label: enter at the open of i+1, exit at TP or after `hold` bars ---
ci, ii = np.where(event)
keep = ii < n - args.hold - 2
ci, ii = ci[keep], ii[keep]
ret = np.full(len(ci), np.nan)
for k, (c, i) in enumerate(zip(ci, ii)):
    e = O[c, i + 1]
    if not np.isfinite(e):
        continue
    px, fund = None, 0.0
    for j in range(i + 1, i + 1 + args.hold):
        if S > 0 and Hh[c, j] >= e * (1 + args.tp):
            px = max(O[c, j], e * (1 + args.tp)) if j > i + 1 else e * (1 + args.tp)
            break
        if S < 0 and L[c, j] <= e * (1 - args.tp):
            px = min(O[c, j], e * (1 - args.tp)) if j > i + 1 else e * (1 - args.tp)
            break
        fund += FUND[c, j] if np.isfinite(FUND[c, j]) else 0.0
    if px is None:
        px = O[c, i + 1 + args.hold]
    if np.isfinite(px):
        ret[k] = S * (px / e - 1) - 2 * COST - S * fund
ok = np.isfinite(ret)
ci, ii, ret = ci[ok], ii[ok], ret[ok]
y = (ret > 0).astype(int)
if args.placebo:
    perm = np.random.default_rng(1).permutation(len(y))
    y, ret = y[perm], ret[perm]
ytrain = y if args.target == 'win' else np.clip(ret, -0.2, 0.2)
print(f'{args.side.upper()} · sự kiện ({args.event_type}): coin {"rơi" if S > 0 else "tăng"} ≥{args.event * 100:.0f}% trong 24h'
      + (' hoặc funding/OI/volume cực đoan' if args.event_type == 'any' else '') + f' · {len(ci):,} mẫu · '
      f'tỷ lệ thắng gốc {y.mean() * 100:.1f}% · lãi TB {ret.mean() * 100:.2f}%/lệnh (TP {args.tp * 100:.0f}%, giữ tối đa {args.hold * 24 // BPD}h)')

# --- feature matrix for event samples only ---
Xc = np.stack([np.asarray(ctx[k])[ci, ii] for k in ctx_names], axis=1).astype(np.float32)
if args.context_only:
    Xe, fnames = Xc, ctx_names
else:
    Xi = np.empty((len(ci), F), dtype=np.float32)
    for c in np.unique(ci):
        sel = np.where(ci == c)[0]
        mm = np.memmap(D / f'X_{syms[c]}.bin', dtype=np.uint8, mode='r', shape=(n, F))
        Xi[sel] = mm[ii[sel]]
    Xi[Xi == 255] = np.nan
    Xe, fnames = np.concatenate([Xi, Xc], axis=1), names + ctx_names

if args.ext:
    ez = np.load(D / 'ext.npz')
    Xx = np.concatenate([ez['coin'][ci, ii], ez['market'][ii]], axis=1).astype(np.float32)
    Xx[~np.isfinite(Xx)] = np.nan
    en = [str(k) for k in ez['coin_names']] + [str(k) for k in ez['market_names']]
    keep = [k for k, nm in enumerate(en) if nm not in set(args.ext_drop.split(','))]
    Xx = Xx[:, keep]
    ez = {'coin_names': [en[k] for k in keep], 'market_names': []}
    Xe = np.concatenate([Xe, Xx], axis=1)
    fnames = fnames + [f'ext_{k}' for k in ez['coin_names']] + [f'ext_{k}' for k in ez['market_names']]
    print(f'+ {Xx.shape[1]} chỉ báo từ nguồn dữ liệu mới')
month = np.array([np.datetime64(int(x), 'ms').astype('datetime64[M]') for x in t])
months = np.unique(month[ii])
test_months = [m for m in months if m >= np.datetime64('2022-02')]
params = dict(objective='binary' if args.target == 'win' else 'huber', alpha=0.05, learning_rate=0.03, num_leaves=15, min_data_in_leaf=200, feature_fraction=0.5,
              bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=4, seed=args.seed)
if args.final:
    if args.event_type != 'drop' or args.side != 'long' or args.ext or args.context_only or args.target != 'win':
        raise SystemExit('--final chỉ hỗ trợ cấu hình dùng cho bot: sự kiện rơi giá, long, không --ext, mục tiêu thắng/thua')
    out = Path(args.final)
    out.mkdir(parents=True, exist_ok=True)
    tr = np.arange(len(ci))[:: args.subsample]
    mdl = lgb.train(params, lgb.Dataset(Xe[tr], ytrain[tr]), 300)
    mdl.save_model(str(out / f'event_seed{args.seed}.txt'))
    (out / 'meta.json').write_text(json.dumps({
        'features': fnames, 'panel_features': names, 'context_features': ctx_names, 'event': args.event, 'tp': args.tp,
        'hold_bars': args.hold, 'bars_per_day': BPD, 'trained_until': str(np.datetime64(int(t[ii.max()]), 'ms')),
        'samples': int(len(tr)), 'base_win_rate': float(y.mean()), 'symbols': syms}, indent=1))
    print(f'Đã lưu mô hình seed {args.seed} ({len(tr):,} sự kiện, đến {np.datetime64(int(t[ii.max()]), "ms")}) → {out}')
    raise SystemExit
if not args.save:
    raise SystemExit('cần --save (nghiên cứu) hoặc --final (bot)')
p = np.full(len(ci), np.nan)
imp = np.zeros(len(fnames))
t0 = time.time()
for m in test_months:
    te = month[ii] == m
    lo = np.argmax(month == m)
    tr = ii < lo - args.hold - 1  # purge: training trades end before the test month starts
    tr = np.where(tr)[0][:: args.subsample]
    mdl = lgb.train(params, lgb.Dataset(Xe[tr], ytrain[tr]), 300)
    p[te] = mdl.predict(Xe[te])
    imp += mdl.feature_importance('gain')
    print(f'  {m}: {len(tr):,} sự kiện để học · {te.sum():,} để dự đoán · {time.time() - t0:.0f}s', flush=True)

oos = np.isfinite(p)
q = np.quantile(p[oos], [0, 0.5, 0.8, 0.9, 0.95, 1])
print('\nTheo nhóm độ tự tin (ngoài mẫu, mọi coin):')
for a, b in zip(q[:-1], q[1:]):
    s = oos & (p >= a) & (p <= b)
    print(f'   xác suất {a:.2f}–{b:.2f}: {s.sum():6d} lệnh · thắng {y[s].mean() * 100:4.1f}% · lãi TB {ret[s].mean() * 100:5.2f}%/lệnh')
dev, fin = oos & (t[ii] < np.datetime64('2025-01-01').astype('datetime64[ms]').astype(np.int64)), None
fin = oos & ~dev
for nm, s in [('2022–2024', dev), ('2025–nay', fin)]:
    top = s & (p >= np.quantile(p[s], 0.8))
    print(f'   {nm}: top 20% tự tin nhất → thắng {y[top].mean() * 100:.1f}% · TB {ret[top].mean() * 100:.2f}%/lệnh · còn lại TB {ret[s & ~top].mean() * 100:.2f}%')
print('\nChỉ báo quan trọng nhất:', ' · '.join(fnames[k] for k in np.argsort(-imp)[:15]))

out = np.full((C, n), np.nan)
out[ci[oos], ii[oos]] = p[oos]
np.savez(args.save, p_dir=out, imp=imp, names=np.array(fnames))
print(f'Đã lưu: {args.save}')
