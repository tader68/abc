#!/usr/bin/env python3
"""Average several walk-forward prediction files (e.g. event models with different seeds or event sets).

Averaging independent models cancels part of each model's noise; every input is already out-of-sample,
so the average is too.

--rank-days D turns each score into a percentile versus all event scores of the previous D days
(computed month by month from the past only). A threshold such as 0.9 then means "top 10% of
recent signals", which stays meaningful however many models are averaged (averaging squeezes raw
probabilities towards the middle, so a fixed 0.85 picks a different number of trades per ensemble).

    python3 research/ml_ensemble.py --out ens.npz [--rank-days 180] ev_long.npz ev_long_s7.npz ev_any.npz
"""
import argparse
import json
import warnings
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--rank-days', type=float, default=0)
ap.add_argument('--dir', default=str(Path(__file__).parent / '.cache/ml/panel_4h'))
ap.add_argument('preds', nargs='+')
args = ap.parse_args()
with warnings.catch_warnings():
    warnings.simplefilter('ignore')  # bars where no model has an event stay NaN
    p = np.nanmean(np.stack([np.load(f)['p_dir'] for f in args.preds]), axis=0)
if args.rank_days:
    t = np.array(json.loads((Path(args.dir) / 'meta.json').read_text())['t'], dtype=np.int64)
    month = np.array([np.datetime64(int(x), 'ms').astype('datetime64[M]') for x in t])
    ci, ii = np.where(np.isfinite(p))
    sc = p[ci, ii]
    out = np.full_like(p, np.nan)
    win = int(args.rank_days * 86400e3)
    for m in np.unique(month[ii]):
        sel = month[ii] == m
        m0 = t[np.argmax(month == m)]
        past = np.sort(sc[(t[ii] < m0) & (t[ii] >= m0 - win)])
        if len(past) < 500:
            continue  # not enough history to rank against
        out[ci[sel], ii[sel]] = np.searchsorted(past, sc[sel], side='right') / len(past)
    p = out
np.savez(args.out, p_dir=p)
print(f'Đã lưu: {args.out} (trung bình {len(args.preds)} mô hình' + (f', xếp hạng so với {args.rank_days:g} ngày trước)' if args.rank_days else ')'))
