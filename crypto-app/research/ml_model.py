#!/usr/bin/env python3
"""ML study: can a gradient-boosting model combining ~240 indicators predict crypto moves?

Data: research/.cache/ml/<market>_<interval>/ written by mlexport.js (causal rolling-rank features).
Walk-forward: retrain every month on all past data (with a purge gap), predict the next month.
Model 1 (direction): P(price up over the next H bars) per coin -> long / short / flat.
Model 2 (ranking): which coins beat the others over the next H bars -> long top 5, short bottom 5.
Execution at the next bar's open, taker fees + slippage, funding. Out-of-sample results only.

    python3 research/ml_model.py [--dir research/.cache/ml/futures_4h] [--horizon 6] [--placebo]
"""
import argparse
import json
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
from scipy.stats import spearmanr

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default=str(Path(__file__).parent / '.cache/ml/futures_4h'))
ap.add_argument('--horizon', type=int, default=6, help='prediction horizon in bars (6 x 4h = 1 day)')
ap.add_argument('--train-months', type=int, default=12, help='minimum history before the first prediction')
ap.add_argument('--placebo', action='store_true', help='shuffle the targets: results must collapse to chance')
ap.add_argument('--out', default='ml-results.json')
ap.add_argument('--macro', action='store_true', help='add macro / event / attention features from <dir>/macro.npz')
ap.add_argument('--trade-symbols', default='', help='comma list: only these coins may be traded in sections 4c-4e')
ap.add_argument('--leaves', type=int, default=31)
ap.add_argument('--lr', type=float, default=0.03)
ap.add_argument('--rounds', type=int, default=300)
ap.add_argument('--only-dir', action='store_true', help='train only the direction model (faster)')
ap.add_argument('--subsample', type=int, default=1, help='use every k-th bar for training (faster on fine bars)')
ap.add_argument('--hours-per-bar', type=float, default=4.0)
ap.add_argument('--save', help='save out-of-sample predictions to this .npz')
ap.add_argument('--load', help='skip training and load predictions from this .npz')
args = ap.parse_args()

D = Path(args.dir)
meta = json.loads((D / 'meta.json').read_text())
names, syms, n, H = meta['features'], meta['symbols'], meta['n'], args.horizon
t = np.array(meta['t'], dtype=np.int64)
F = len(names)
COST = 0.0005 + 0.0005  # taker fee + slippage per side
print(f'{len(syms)} coin × {n} nến × {F} chỉ báo · dự đoán {H} nến tới ({H * args.hours_per_bar:g} giờ)')

X = np.stack([np.fromfile(D / f'X_{s}.bin', dtype=np.uint8).reshape(n, F) for s in syms]).astype(np.float32)  # [coin, bar, f]
X[X == 255] = np.nan
P = np.stack([np.fromfile(D / f'P_{s}.bin', dtype=np.float64).reshape(n, 5) for s in syms])  # [coin, bar, (o,h,l,c,fund)]
C = len(syms)
O, CL, FUND = P[:, :, 0], P[:, :, 3], P[:, :, 4]

# cross-sectional ranks of a few key indicators (where each coin stands versus the others right now)
cs_names = [x for x in ['ret1', 'ret3', 'ret8', 'ret21', 'ret55', 'ret144', 'atrPct14', 'volZ20', 'rsi14', 'fundRate', 'oiChg6', 'takerBuyRatio8', 'distHigh55', 'relStrength24'] if x in names]
cs = []
for nm in cs_names:
    v = X[:, :, names.index(nm)]
    with np.errstate(invalid='ignore'):
        r = np.argsort(np.argsort(np.where(np.isnan(v), -np.inf, v), axis=0), axis=0).astype(np.float32)
    r = r / (C - 1)
    r[np.isnan(v)] = np.nan
    cs.append(r)
X = np.concatenate([X, np.stack(cs, axis=2)], axis=2)
all_names = names + [f'cs_{x}' for x in cs_names]
if args.macro:
    mz = np.load(D / 'macro.npz')
    Mmac = mz['M'].astype(np.float32)  # [bar, feature], same for every coin
    X = np.concatenate([X, np.broadcast_to(Mmac[None, :, :], (C, n, Mmac.shape[1]))], axis=2)
    all_names += [f'macro_{x}' for x in mz['names']]
    print(f'+ {Mmac.shape[1]} chỉ báo vĩ mô / sự kiện / mức độ quan tâm')
F2 = len(all_names)

# targets: return from the next bar's open over H bars (decision at the close of bar i)
fwd = np.full((C, n), np.nan)
fwd[:, : n - H - 1] = O[:, 1 + H : n] / O[:, 1 : n - H] - 1
fund_fwd = np.zeros((C, n))
cf = np.cumsum(np.concatenate([np.zeros((C, 1)), FUND], axis=1), axis=1)
fund_fwd[:, : n - H - 1] = cf[:, 1 + H : n] - cf[:, 1 : n - H]  # funding during bars i+1 .. i+H
ex = fwd - np.nanmean(fwd, axis=0, keepdims=True)  # excess return versus the average coin

if args.placebo:
    rng = np.random.default_rng(0)
    for c in range(C):
        rng.shuffle(fwd[c])
    ex = fwd - np.nanmean(fwd, axis=0, keepdims=True)

# months for walk-forward
month = np.array([np.datetime64(int(x), 'ms').astype('datetime64[M]') for x in t])
valid = ~np.isnan(X[:, :, names.index('ret144')]).all(axis=0)  # warm-up done
first = np.argmax(valid)
months = np.unique(month[first:])
test_months = months[args.train_months :]
print(f'Dữ liệu từ {month[first]} · dự đoán ngoài mẫu (walk-forward) từ {test_months[0]} đến {test_months[-1]} ({len(test_months)} tháng)\n')

params_cls = dict(objective='binary', learning_rate=args.lr, num_leaves=args.leaves, min_data_in_leaf=400, feature_fraction=0.5,
                  bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=4)
params_reg = dict(params_cls, objective='regression')
ROUNDS = args.rounds

p_dir = np.full((C, n), np.nan)
p_rank = np.full((C, n), np.nan)
imp = np.zeros(F2)
t0 = time.time()
if args.load:
    z = np.load(args.load)
    p_dir, p_rank, imp = z['p_dir'], z['p_rank'], z['imp']
for m in ([] if args.load else test_months):
    test_idx = np.where(month == m)[0]
    lo = test_idx[0]
    train_bars = np.arange(first, max(first, lo - H - 1))[:: args.subsample]  # purge: targets end before the test month
    Xtr = X[:, train_bars, :].reshape(-1, F2)
    ytr = fwd[:, train_bars].reshape(-1)
    etr = ex[:, train_bars].reshape(-1)
    ok = ~np.isnan(ytr)
    m1 = lgb.train(params_cls, lgb.Dataset(Xtr[ok], (ytr[ok] > 0).astype(int)), ROUNDS)
    # ranking target: excess return standardised per bar (robust to volatility regimes)
    m2 = None if args.only_dir else lgb.train(params_reg, lgb.Dataset(Xtr[ok], np.clip(etr[ok] / (np.nanstd(etr[ok]) + 1e-12), -3, 3)), ROUNDS)
    imp += m1.feature_importance('gain') + (m2.feature_importance('gain') if m2 else 0)
    Xte = X[:, test_idx, :].reshape(-1, F2)
    p_dir[:, test_idx] = m1.predict(Xte).reshape(C, len(test_idx))
    if m2:
        p_rank[:, test_idx] = m2.predict(Xte).reshape(C, len(test_idx))
    print(f'  {m}: huấn luyện trên {ok.sum():,} mẫu · {time.time() - t0:.0f}s', flush=True)

if args.save:
    np.savez(args.save, p_dir=p_dir, p_rank=p_rank, imp=imp)
oos = np.isin(month, test_months)

# ---------- prediction quality ----------
def auc(p, y):
    order = np.argsort(p)
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    pos = y == 1
    return (ranks[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * (~pos).sum())

mask = oos[None, :] & ~np.isnan(fwd) & ~np.isnan(p_dir)
yy, pp = (fwd[mask] > 0).astype(int), p_dir[mask]
acc = ((pp > 0.5) == yy).mean()
conf = np.abs(pp - 0.5) > 0.05
print(f'\n1) MÔ HÌNH DỰ ĐOÁN HƯỚNG ({H * args.hours_per_bar:g}h tới), ngoài mẫu: {mask.sum():,} dự đoán')
print(f'   Đúng hướng: {acc * 100:.2f}% (tung đồng xu: 50%; tỷ lệ nến tăng thực tế {yy.mean() * 100:.1f}%) · AUC {auc(pp, yy):.3f}')
print(f'   Khi mô hình "chắc chắn" (xác suất >55% hoặc <45%): {conf.mean() * 100:.0f}% số lần · đúng {(((pp > 0.5) == yy)[conf]).mean() * 100:.2f}%')

# daily information coefficient of the ranking model
ics = []
bars_oos = np.where(oos)[0]
for i in bars_oos[::H]:
    a, b = p_rank[:, i], ex[:, i]
    k = ~np.isnan(a) & ~np.isnan(b)
    if k.sum() >= 10:
        ics.append(spearmanr(a[k], b[k])[0])
ics = np.array(ics) if ics else np.array([0.0])
print(f'\n2) MÔ HÌNH XẾP HẠNG COIN: tương quan dự đoán ↔ kết quả (IC) trung bình {ics.mean():.4f} · t={ics.mean() / ics.std() * np.sqrt(len(ics)):.2f} · {(ics > 0).mean() * 100:.0f}% số ngày dương')

# ---------- trading ----------
def stats(rets, label):
    rets = np.array(rets)
    eq = np.cumprod(1 + rets)
    dd = 1 - eq / np.maximum.accumulate(eq)
    per_year = 365 * 24 / (args.hours_per_bar * H)
    tstat = rets.mean() / rets.std() * np.sqrt(len(rets)) if rets.std() > 0 else 0
    return {'label': label, 'total': (eq[-1] - 1) * 100, 'cagr': (eq[-1] ** (per_year / len(rets)) - 1) * 100, 'maxDD': dd.max() * 100, 't': tstat, 'win': (rets > 0).mean() * 100}

steps = bars_oos[::H]
steps = steps[steps < n - H - 2]
step_month = month[steps]
results = []
print(f'\n3) GIAO DỊCH THEO MÔ HÌNH (mỗi {H * args.hours_per_bar:g}h, khớp ở giá mở cửa nến sau, phí {COST * 200:.1f}% mỗi lần vào+ra, có funding):')
for tau in [0.0, 0.02, 0.05]:
    prev = np.zeros(C)
    rets = []
    for i in steps:
        pos = np.where(p_dir[:, i] > 0.5 + tau, 1.0, np.where(p_dir[:, i] < 0.5 - tau, -1.0, 0.0))
        pos[np.isnan(p_dir[:, i]) | np.isnan(fwd[:, i])] = 0
        w = pos / C
        r = np.nansum(w * fwd[:, i]) - np.nansum(w * fund_fwd[:, i]) - np.abs(w - prev / C).sum() * COST
        prev = pos
        rets.append(r)
    s = stats(rets, f'Long/short từng coin theo hướng dự đoán (ngưỡng ±{tau * 100:.0f}%)')
    results.append(s)
def rank_strategy(K, every, cost, smooth):
    rets = []
    prevw = np.zeros(C)
    w = np.zeros(C)
    for j, i in enumerate(steps):
        if j % every == 0:
            # average the last `smooth` daily predictions to reduce churn
            a = np.nanmean(p_rank[:, [s for s in steps[max(0, j - smooth + 1) : j + 1]]], axis=1)
            k = ~np.isnan(a) & ~np.isnan(fwd[:, i])
            w = np.zeros(C)
            if k.sum() >= 2 * K:
                idx = np.where(k)[0][np.argsort(a[k])]
                w[idx[-K:]] = 0.5 / K
                w[idx[:K]] = -0.5 / K
        r = np.nansum(w * fwd[:, i]) - np.nansum(w * fund_fwd[:, i]) - np.abs(w - prevw).sum() * cost
        prevw = w
        rets.append(r)
    return rets

for K, every, smooth in ([] if args.only_dir else [(5, 1, 1), (5, 3, 3), (5, 7, 7), (10, 7, 7)]):
    results.append(stats(rank_strategy(K, every, 0.0, smooth), f'[TRƯỚC PHÍ] long {K} / short {K}, đổi danh mục mỗi {every} ngày'))
    results.append(stats(rank_strategy(K, every, COST, smooth), f'[SAU PHÍ]   long {K} / short {K}, đổi danh mục mỗi {every} ngày'))
bh = stats([np.nanmean(fwd[:, i]) for i in steps], 'Đối chứng: giữ đều tất cả coin')
for s in results + [bh]:
    print(f'   • {s["label"]}\n     tổng {s["total"]:7.1f}% · {s["cagr"]:6.1f}%/năm · sụt tối đa {s["maxDD"]:5.1f}% · t-stat {s["t"]:5.2f} · {s["win"]:.0f}% số kỳ lãi')

tradable = np.array([(not args.trade_symbols) or (s in args.trade_symbols.split(',')) for s in syms])
# ---------- trade only the most confident predictions ----------
print(f'\n4b) CHỈ GIAO DỊCH KHI MÔ HÌNH TỰ TIN NHẤT (mỗi {H * args.hours_per_bar:g}h chọn N coin có xác suất xa 50% nhất, long nếu >50%, short nếu <50%):')
bins = np.quantile(np.abs(pp - 0.5), [0, 0.5, 0.8, 0.9, 0.95, 0.99, 1])
for lo, hi in zip(bins[:-1], bins[1:]):
    sel = (np.abs(pp - 0.5) >= lo) & (np.abs(pp - 0.5) <= hi)
    print(f'   độ tự tin {lo:.3f}–{hi:.3f}: {sel.sum():7d} dự đoán · đúng hướng {((pp[sel] > 0.5) == yy[sel]).mean() * 100:.1f}%')
for N in [1, 3, 5]:
    for min_conf in [0.0, 0.05, 0.1]:
        rets = []
        prevw = np.zeros(C)
        for i in steps:
            pr = p_dir[:, i]
            ok = ~np.isnan(pr) & ~np.isnan(fwd[:, i]) & (np.abs(pr - 0.5) >= min_conf)
            w = np.zeros(C)
            if ok.any():
                idx = np.where(ok)[0][np.argsort(-np.abs(pr[ok] - 0.5))][:N]
                w[idx] = np.sign(pr[idx] - 0.5) / N
            r = np.nansum(w * fwd[:, i]) - np.nansum(w * fund_fwd[:, i]) - np.abs(w - prevw).sum() * COST
            prevw = w
            rets.append(r)
        s = stats(rets, f'top {N} coin tự tin nhất, chỉ khi xác suất lệch ≥{min_conf * 100:.0f}%')
        results.append(s)
        print(f'   • {s["label"]}: {s["cagr"]:6.1f}%/năm · sụt {s["maxDD"]:5.1f}% · t={s["t"]:5.2f} · {s["win"]:.0f}% số kỳ lãi')

# only very confident predictions, every coin that clears the bar (how concentrated are they?)
print('\n4c) CHỈ VÀO LỆNH KHI ĐỘ TỰ TIN VƯỢT NGƯỠNG (mọi coin vượt ngưỡng, chia đều vốn):')
for thr in [0.2, 0.25, 0.3, 0.33]:
    rets, ndays, nlong, nshort, per_trade = [], 0, 0, 0, []
    prevw = np.zeros(C)
    for i in steps:
        pr = p_dir[:, i]
        ok = ~np.isnan(pr) & ~np.isnan(fwd[:, i]) & (np.abs(pr - 0.5) >= thr) & tradable
        w = np.zeros(C)
        if ok.any():
            ndays += 1
            w[ok] = np.sign(pr[ok] - 0.5) / ok.sum()
            nlong += int((pr[ok] > 0.5).sum())
            nshort += int((pr[ok] < 0.5).sum())
            per_trade += list(np.sign(pr[ok] - 0.5) * fwd[ok, i] - 2 * COST)
        r = np.nansum(w * fwd[:, i]) - np.nansum(w * fund_fwd[:, i]) - np.abs(w - prevw).sum() * COST
        prevw = w
        rets.append(r)
    s = stats(rets, f'ngưỡng ±{thr * 100:.0f}%')
    pt = np.array(per_trade)
    print(f'   • ngưỡng ±{thr * 100:.0f}%: có lệnh {ndays}/{len(steps)} ngày · {nlong} long / {nshort} short · lãi TB/lệnh sau phí {pt.mean() * 100 if len(pt) else 0:.2f}% (thắng {(pt > 0).mean() * 100 if len(pt) else 0:.0f}%) · danh mục {s["cagr"]:.1f}%/năm · sụt {s["maxDD"]:.1f}% · t={s["t"]:.2f}')

# what are those confident days? per-year stability and the market move just before them
print('\n4d) NHỮNG NGÀY MÔ HÌNH RẤT TỰ TIN (≥30%): ổn định theo năm không, và trước đó thị trường làm gì?')
mkt_past = np.full(n, np.nan)  # average coin return over the 3 days (18 bars) before the decision
mkt_past[18:] = np.nanmean(CL[:, 18:] / CL[:, :-18] - 1, axis=0)
for thr in [0.25, 0.3]:
    by_year = {}
    past = []
    for i in steps:
        pr = p_dir[:, i]
        ok = ~np.isnan(pr) & ~np.isnan(fwd[:, i]) & (np.abs(pr - 0.5) >= thr) & tradable
        if not ok.any():
            continue
        y = str(month[i])[:4]
        by_year.setdefault(y, []).extend(list(np.sign(pr[ok] - 0.5) * fwd[ok, i] - 2 * COST))
        past.append(mkt_past[i])
    yrs = ' · '.join(f'{y}: {len(v)} lệnh, TB {np.mean(v) * 100:.1f}%, thắng {(np.array(v) > 0).mean() * 100:.0f}%' for y, v in sorted(by_year.items()))
    print(f'   ngưỡng ±{thr * 100:.0f}%: {yrs}')
    print(f'      thị trường 3 ngày trước đó: trung bình {np.nanmean(past) * 100:.1f}% (mọi ngày: {np.nanmean(mkt_past[steps]) * 100:.1f}%)')

# position cap: at most 10% of equity per coin (the rest stays in cash) + the worst trades
print('\n4e) GIỚI HẠN MỖI LỆNH TỐI ĐA 10% VỐN (phần còn lại để tiền mặt) + các lệnh tệ nhất:')
for thr in [0.25, 0.3]:
    rets, trades = [], []
    prevw = np.zeros(C)
    for i in steps:
        pr = p_dir[:, i]
        ok = ~np.isnan(pr) & ~np.isnan(fwd[:, i]) & (np.abs(pr - 0.5) >= thr) & tradable
        w = np.zeros(C)
        if ok.any():
            w[ok] = np.sign(pr[ok] - 0.5) / max(ok.sum(), 10)
            for c in np.where(ok)[0]:
                trades.append((float(np.sign(pr[c] - 0.5) * fwd[c, i] - 2 * COST), syms[c], str(np.datetime64(int(t[i]), 'ms'))[:10]))
        r = np.nansum(w * fwd[:, i]) - np.nansum(w * fund_fwd[:, i]) - np.abs(w - prevw).sum() * COST
        prevw = w
        rets.append(r)
    s = stats(rets, f'cap10 ±{thr}')
    eq = np.cumprod(1 + np.array(rets))
    yearly = {}
    for i, e in zip(steps, eq):
        yearly[str(month[i])[:4]] = e
    prev, ys = 1.0, []
    for y, e in yearly.items():
        ys.append(f'{y} {(e / prev - 1) * 100:+.0f}%')
        prev = e
    worst = sorted(trades)[:5]
    print(f'   ngưỡng ±{thr * 100:.0f}%: {s["cagr"]:.1f}%/năm · sụt {s["maxDD"]:.1f}% · t={s["t"]:.2f} · theo năm: {" · ".join(ys)}')
    print('      lệnh tệ nhất: ' + ', '.join(f'{sym} {d} {r * 100:.0f}%' for r, sym, d in worst))

# monthly view of the best strategy
best = max(results, key=lambda s: s['t'])
print(f'\nChiến lược có t-stat cao nhất: {best["label"]} (t={best["t"]:.2f}; cần ≥ 2.5 mới coi là lợi thế thật)')

top = np.argsort(-imp)[:15]
print('\n4) Mô hình dựa vào những chỉ báo nào nhiều nhất:')
print('   ' + ' · '.join(f'{all_names[k]}' for k in top))

json.dump({'horizon': H, 'months': [str(m) for m in test_months], 'accuracy': acc, 'ic_mean': float(ics.mean()), 'strategies': results, 'benchmark': bh,
           'importance': [[all_names[k], float(imp[k])] for k in np.argsort(-imp)[:40]], 'placebo': args.placebo}, open(args.out, 'w'), indent=1)
print(f'\nĐã lưu: {args.out}')
