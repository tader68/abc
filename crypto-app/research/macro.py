#!/usr/bin/env python3
"""Macro, traditional-market, event-calendar and attention features for the ML panel.

Daily data (Yahoo Finance: S&P 500, Nasdaq 100, VIX, dollar index, US 10y yield, gold, oil, BTC ETF
volume; Wikipedia page views as a crowd-attention proxy) are aligned to each 4h bar using only the
LAST COMPLETED day before that bar (no look-ahead). Scheduled events (FOMC decisions, US jobs
reports) are known in advance, so hours-to-next / hours-since-last are legitimate features.

Writes <panel dir>/macro.npz with a [n_bars, n_features] float32 matrix aligned to meta.json.

    python3 research/macro.py [--dir research/.cache/ml/panel_4h]
"""
import argparse
import datetime as dt
import json
import time
import urllib.request
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default=str(Path(__file__).parent / '.cache/ml/panel_4h'))
args = ap.parse_args()
D = Path(args.dir)
meta = json.loads((D / 'meta.json').read_text())
T = np.array(meta['t'], dtype=np.int64)  # bar open times (ms)
n = len(T)
UA = {'User-Agent': 'Mozilla/5.0'}


def get_json(url):
    for k in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read())
        except Exception:  # noqa: BLE001 - retry any network error
            time.sleep(2 * (k + 1))
    raise RuntimeError(url)


start = int(dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc).timestamp())
end = int(time.time())


def yahoo(symbol):
    j = get_json(f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}?period1={start}&period2={end}&interval=1d')
    r = j['chart']['result'][0]
    q = r['indicators']['quote'][0]
    days = [dt.datetime.fromtimestamp(x, dt.timezone.utc).date() for x in r['timestamp']]
    return {d: (c, v) for d, c, v in zip(days, q['close'], q['volume']) if c is not None}


def wiki(article):
    j = get_json(f'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{article}/daily/20200101/{dt.date.today() - dt.timedelta(days=2):%Y%m%d}')
    return {dt.datetime.strptime(x['timestamp'][:8], '%Y%m%d').date(): (float(x['views']), 0) for x in j['items']}


SOURCES = {'spx': ('^GSPC', yahoo), 'ndx': ('^NDX', yahoo), 'vix': ('^VIX', yahoo), 'dxy': ('DX-Y.NYB', yahoo), 'us10y': ('^TNX', yahoo),
           'gold': ('GC=F', yahoo), 'oil': ('CL=F', yahoo), 'ibit': ('IBIT', yahoo), 'wiki_btc': ('Bitcoin', wiki), 'wiki_crypto': ('Cryptocurrency', wiki)}
raw = {}
for name, (sym, fn) in SOURCES.items():
    try:
        raw[name] = fn(sym)
    except RuntimeError:
        raw[name] = {}  # source unavailable: its features stay NaN (the model handles missing values)
    time.sleep(1)
    print(f'  {name:12s} {len(raw[name])} ngày')

# daily feature table over calendar days (tradfi values carried over weekends/holidays)
days = [dt.date(2020, 1, 1) + dt.timedelta(k) for k in range((dt.date.today() - dt.date(2020, 1, 1)).days + 1)]


def series(name, idx=0):
    out, last = [], np.nan
    for d in days:
        if d in raw[name] and raw[name][d][idx] is not None:
            last = raw[name][d][idx]
        out.append(last)
    return np.array(out, dtype=float)


def ret(x, k):
    r = np.full_like(x, np.nan)
    r[k:] = x[k:] / x[:-k] - 1
    return r


def sma_dist(x, k):
    r = np.full_like(x, np.nan)
    c = np.convolve(x, np.ones(k) / k, mode='valid')
    r[k - 1 :] = x[k - 1 :] / c - 1
    return r


def zscore(x, k):
    r = np.full_like(x, np.nan)
    for i in range(k, len(x)):
        w = x[i - k : i]
        s = np.nanstd(w)
        r[i] = (x[i] - np.nanmean(w)) / s if s > 0 else np.nan
    return r


feat = {}
for nm in ['spx', 'ndx', 'dxy', 'gold', 'oil']:
    x = series(nm)
    for k in [1, 5, 20]:
        feat[f'{nm}_ret{k}'] = ret(x, k)
    feat[f'{nm}_sma50'] = sma_dist(x, 50)
spx = series('spx')
feat['spx_sma200'] = sma_dist(spx, 200)
lr = np.log(spx)
feat['spx_vol20'] = np.array([np.nanstd(np.diff(lr[max(0, i - 20) : i + 1])) if i > 20 else np.nan for i in range(len(lr))])
vix = series('vix')
feat['vix'] = vix
feat['vix_chg5'] = ret(vix, 5)
tnx = series('us10y')
feat['us10y'] = tnx
feat['us10y_chg20'] = np.r_[np.full(20, np.nan), tnx[20:] - tnx[:-20]]
ibit_v = series('ibit', 1)
feat['etf_volume_z'] = zscore(np.log(ibit_v + 1), 30)
for nm in ['wiki_btc', 'wiki_crypto']:
    feat[f'{nm}_z30'] = zscore(np.log(series(nm) + 1), 30)
    feat[f'{nm}_chg7'] = ret(series(nm), 7)

day_index = {d: i for i, d in enumerate(days)}
names = list(feat)
M = np.full((n, len(names) + 8), np.nan, dtype=np.float32)
for b in range(n):
    d = dt.datetime.fromtimestamp(T[b] / 1000, dt.timezone.utc).date() - dt.timedelta(days=1)  # last COMPLETED day
    i = day_index.get(d)
    if i is not None:
        M[b, : len(names)] = [feat[k][i] for k in names]

# scheduled events (UTC): FOMC statements ~18:30, US jobs report first Friday ~12:30
FOMC = ['2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
        '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
        '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
        '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
        '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
        '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']
fomc_ms = np.array([int(dt.datetime.fromisoformat(d + 'T18:30:00+00:00').timestamp() * 1000) for d in FOMC])
nfp = []
for y in range(2021, 2027):
    for m in range(1, 13):
        d = dt.date(y, m, 1)
        d += dt.timedelta((4 - d.weekday()) % 7)  # first Friday
        nfp.append(int(dt.datetime(d.year, d.month, d.day, 12, 30, tzinfo=dt.timezone.utc).timestamp() * 1000))
nfp_ms = np.array(nfp)


def to_next(ev, t):
    k = np.searchsorted(ev, t)
    return (ev[k] - t) / 3.6e6 if k < len(ev) else np.nan


def since_last(ev, t):
    k = np.searchsorted(ev, t) - 1
    return (t - ev[k]) / 3.6e6 if k >= 0 else np.nan


j = len(names)
for b in range(n):
    tb = T[b] + 4 * 3.6e6  # decision at the close of the bar
    M[b, j] = to_next(fomc_ms, tb)
    M[b, j + 1] = since_last(fomc_ms, tb)
    M[b, j + 2] = to_next(nfp_ms, tb)
    M[b, j + 3] = since_last(nfp_ms, tb)
    w = dt.datetime.fromtimestamp(tb / 1000, dt.timezone.utc)
    M[b, j + 4] = w.weekday()
    M[b, j + 5] = w.hour
    M[b, j + 6] = 1.0 if w.weekday() >= 5 else 0.0  # weekend: traditional markets closed
    M[b, j + 7] = 1.0 if M[b, j + 1] < 48 else 0.0  # within 2 days after an FOMC decision
names += ['h_to_fomc', 'h_since_fomc', 'h_to_nfp', 'h_since_nfp', 'weekday', 'hour', 'weekend', 'post_fomc_48h']
np.savez(D / 'macro.npz', M=M, names=np.array(names))
print(f'Đã ghi {len(names)} chỉ báo vĩ mô/sự kiện → {D / "macro.npz"}')
