#!/usr/bin/env python3
"""Let the model choose the exit for each trade.

Takes several event models trained with --target ret, each for a different exit plan
(take-profit, maximum holding time), and for every event picks the plan with the highest
predicted return. Writes a predictions file whose p_dir is that best predicted return, plus the
chosen tp / hold per signal, which ml_improve.py uses instead of a fixed exit.

    python3 research/ml_plan.py --out plan.npz ev_ret_0.04_6.npz:0.04:6 ev_ret_0.08_18.npz:0.08:18 ...
    npm run ml:improve -- --pred plan.npz --thr-mode abs --thr-list 0.005,0.01,0.015,0.02
"""
import argparse

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('models', nargs='+', help='file.npz:tp:hold_bars')
args = ap.parse_args()

preds, tps, holds = [], [], []
for spec in args.models:
    f, tp, h = spec.split(':')
    preds.append(np.load(f)['p_dir'])
    tps.append(float(tp))
    holds.append(int(h))
Pm = np.stack(preds)  # [plan, coin, bar]
have = np.isfinite(Pm).all(axis=0)
best = np.argmax(np.where(np.isfinite(Pm), Pm, -np.inf), axis=0)
p_dir = np.where(have, np.take_along_axis(Pm, best[None], 0)[0], np.nan)
tp = np.array(tps)[best]
hold = np.array(holds)[best]
np.savez(args.out, p_dir=p_dir, tp=np.where(have, tp, np.nan), hold=np.where(have, hold, 0))
sel = have & (p_dir > 0.01)
print('Kế hoạch được chọn khi dự đoán lãi >1%: ' + ' · '.join(f'TP {tps[k] * 100:.0f}%/giữ {holds[k] * 4}h: {(best[sel] == k).mean() * 100:.0f}%' for k in range(len(tps))))
print(f'Đã lưu: {args.out}')
