#!/usr/bin/env python3
"""Average several walk-forward prediction files (e.g. event models with different seeds or event sets).

Averaging independent models cancels part of each model's noise; every input is already out-of-sample,
so the average is too.

    python3 research/ml_ensemble.py --out ens.npz ev_long.npz ev_long_s7.npz ev_any.npz
"""
import argparse
import warnings

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('preds', nargs='+')
args = ap.parse_args()
with warnings.catch_warnings():
    warnings.simplefilter('ignore')  # bars where no model has an event stay NaN
    p = np.nanmean(np.stack([np.load(f)['p_dir'] for f in args.preds]), axis=0)
np.savez(args.out, p_dir=p)
print(f'Đã lưu: {args.out} (trung bình {len(args.preds)} mô hình)')
