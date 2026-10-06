#!/usr/bin/env python3
"""Extra data sources for the event model, aligned to the 4h panel (known at each bar's close).

Per coin:
  * Binance futures premium index (perp price vs spot index): close, 24h mean, 30-day z-score
Market-wide:
  * Coinbase premium: BTC-USD on Coinbase vs BTCUSDT on Binance (US / institutional demand)
  * Deribit DVOL: implied volatility of BTC and ETH options, level and 24h change
  * BTC order book depth (Binance futures, 2023+): bid vs ask notional within 1/2/5% of price
  * Total stablecoin supply (DefiLlama): 7- and 30-day change, last completed day only

Writes <panel dir>/ext.npz with coin[C, n, k], market[n, m] and their names.

    python3 research/extdata.py [--dir research/.cache/ml/panel_4h]
"""
import argparse
import csv
import datetime as dt
import io
import json
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default=str(Path(__file__).parent / '.cache/ml/panel_4h'))
ap.add_argument('--no-depth', action='store_true')
args = ap.parse_args()
D = Path(args.dir)
meta = json.loads((D / 'meta.json').read_text())
syms, n = meta['symbols'], meta['n']
T = np.array(meta['t'], dtype=np.int64)
C = len(syms)
BAR = 4 * 3600_000
CACHE = Path(__file__).parent / '.cache/ext'
CACHE.mkdir(parents=True, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0'}
idx = {int(x): i for i, x in enumerate(T)}


def get(url, binary=False, cache=None):
    if cache and (CACHE / cache).exists():
        b = (CACHE / cache).read_bytes()
        return b if binary else json.loads(b)
    for k in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                b = r.read()
            if cache:
                (CACHE / cache).write_bytes(b)
            return b if binary else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                if cache:
                    (CACHE / cache).write_bytes(b'' if binary else b'null')
                return b'' if binary else None
            time.sleep(2 * (k + 1))
        except Exception:  # noqa: BLE001 - retry network errors
            time.sleep(2 * (k + 1))
    return b'' if binary else None


def bar_of(ms):
    return idx.get(int(ms) // BAR * BAR)


# ---------- premium index (per coin, monthly 4h archives) ----------
months = []
d = dt.date(2021, 1, 1)
while d <= dt.date.today():
    months.append(f'{d:%Y-%m}')
    d = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
prem = np.full((C, n), np.nan, dtype=np.float32)


def fetch_prem(job):
    c, m = job
    s = syms[c]
    b = get(f'https://data.binance.vision/data/futures/um/monthly/premiumIndexKlines/{s}/4h/{s}-4h-{m}.zip', True, f'prem_{s}_{m}.zip')
    if not b and m == f'{dt.date.today():%Y-%m}':
        # current month is not archived yet: daily files
        y, mo = map(int, m.split('-'))
        out = []
        for day in range(1, 32):
            try:
                dd = dt.date(y, mo, day)
            except ValueError:
                break
            if dd >= dt.date.today():
                break
            bd = get(f'https://data.binance.vision/data/futures/um/daily/premiumIndexKlines/{s}/4h/{s}-4h-{dd}.zip', True, f'prem_{s}_{dd}.zip')
            if bd:
                out.append(bd)
        return c, out
    return c, [b]


jobs = [(c, m) for c in range(C) for m in months]
with ThreadPoolExecutor(16) as ex:
    for k, (c, blobs) in enumerate(ex.map(fetch_prem, jobs)):
        for b in blobs:
            try:
                z = zipfile.ZipFile(io.BytesIO(b))
                for row in csv.reader(io.TextIOWrapper(z.open(z.namelist()[0]))):
                    if not row[0].isdigit():
                        continue
                    i = bar_of(int(row[0]))
                    if i is not None:
                        prem[c, i] = float(row[4])
            except zipfile.BadZipFile:
                pass
        if k % 1000 == 0:
            print(f'  premium {k}/{len(jobs)}', flush=True)


def roll_mean(a, w):
    f = np.isfinite(a)
    x = np.where(f, a, 0.0)
    cs = lambda v: np.concatenate([np.zeros(v.shape[:-1] + (1,)), np.cumsum(v, axis=-1)], axis=-1)  # noqa: E731
    k, s1, s2 = cs(f.astype(float)), cs(x), cs(x * x)
    k, s1, s2 = (z[..., w:] - z[..., :-w] for z in (k, s1, s2))
    m = np.full(a.shape, np.nan)
    sd = np.full(a.shape, np.nan)
    with np.errstate(invalid='ignore', divide='ignore'):
        m[..., w - 1 :] = np.where(k > w // 2, s1 / k, np.nan)
        sd[..., w - 1 :] = np.where(k > w // 2, np.sqrt(np.maximum(s2 / k - (s1 / k) ** 2, 0)), np.nan)
    return m, sd


pm6, _ = roll_mean(prem, 6)
pm180, ps180 = roll_mean(prem, 180)
with np.errstate(invalid='ignore', divide='ignore'):
    coin = {'prem': prem, 'prem_24h': pm6, 'prem_z30': (prem - pm180) / ps180}
print(f'premium index: {np.isfinite(prem).mean() * 100:.0f}% ô có dữ liệu')

market = {}
# ---------- Coinbase premium (hourly candles, aggregated to the 4h bar's last close) ----------
cb = np.full(n, np.nan)
start = int(T[0] / 1000)
end = int(T[-1] / 1000) + 4 * 3600
step = 300 * 3600
for a in range(start, end, step):
    b = min(a + step, end)
    j = get(f'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start={a}&end={b}', cache=f'cb_{a}.json')
    for row in j or []:
        i = bar_of(row[0] * 1000)
        if i is not None and (row[0] * 1000) % BAR == BAR - 3600_000:  # last hour of the 4h bar
            cb[i] = row[4]
btc_close = np.fromfile(D / 'P_BTCUSDT.bin', dtype=np.float64).reshape(n, 5)[:, 3]
market['cb_prem'] = cb / btc_close - 1
cbm, cbs = roll_mean(market['cb_prem'][None], 180)
market['cb_prem_z30'] = ((market['cb_prem'] - cbm[0]) / cbs[0])
market['cb_prem_24h'] = roll_mean(market['cb_prem'][None], 6)[0][0]
print(f'Coinbase premium: {np.isfinite(cb).mean() * 100:.0f}% nến có dữ liệu')

# ---------- Deribit DVOL ----------
for cur in ['BTC', 'ETH']:
    v = np.full(n, np.nan)
    a = int(T[0])
    while a < T[-1] + BAR:
        b = a + 1000 * 3600_000
        j = get(f'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency={cur}&start_timestamp={a}&end_timestamp={b}&resolution=3600', cache=f'dvol_{cur}_{a}.json')
        for row in (j or {}).get('result', {}).get('data', []):
            i = bar_of(row[0])
            if i is not None and row[0] % BAR == BAR - 3600_000:
                v[i] = row[4]
        a = b
    market[f'dvol_{cur.lower()}'] = v
    with np.errstate(invalid='ignore'):
        market[f'dvol_{cur.lower()}_chg24h'] = np.r_[np.full(6, np.nan), v[6:] / v[:-6] - 1]
    print(f'DVOL {cur}: {np.isfinite(v).mean() * 100:.0f}% nến có dữ liệu')

# ---------- stablecoin supply (daily, last completed day) ----------
j = get('https://stablecoins.llama.fi/stablecoincharts/all', cache='stables.json') or []
sup = {dt.datetime.fromtimestamp(int(r['date']), dt.timezone.utc).date(): r['totalCirculatingUSD'].get('peggedUSD', np.nan) for r in j}
days = sorted(sup)
arr = np.array([sup[x] for x in days], dtype=float)
chg7 = dict(zip(days, np.r_[np.full(7, np.nan), arr[7:] / arr[:-7] - 1]))
chg30 = dict(zip(days, np.r_[np.full(30, np.nan), arr[30:] / arr[:-30] - 1]))
market['stables_chg7'] = np.full(n, np.nan)
market['stables_chg30'] = np.full(n, np.nan)
for i in range(n):
    dd = dt.datetime.fromtimestamp(T[i] / 1000, dt.timezone.utc).date() - dt.timedelta(days=1)
    market['stables_chg7'][i] = chg7.get(dd, np.nan)
    market['stables_chg30'][i] = chg30.get(dd, np.nan)
print(f'stablecoin: {np.isfinite(market["stables_chg7"]).mean() * 100:.0f}% nến có dữ liệu')

# ---------- BTC order book depth (daily files 2023+, snapshots ~every 30s) ----------
if not args.no_depth:
    bids = {p: np.full(n, np.nan) for p in (1, 2, 5)}
    asks = {p: np.full(n, np.nan) for p in (1, 2, 5)}
    dd = dt.date(2023, 1, 1)
    dates = []
    while dd < dt.date.today():
        dates.append(dd)
        dd += dt.timedelta(days=1)

    def fetch_depth(day):
        return day, get(f'https://data.binance.vision/data/futures/um/daily/bookDepth/BTCUSDT/BTCUSDT-bookDepth-{day}.zip', True, f'depth_BTC_{day}.zip')

    with ThreadPoolExecutor(16) as ex:
        for day, b in ex.map(fetch_depth, dates):
            if not b:
                continue
            last = {}
            try:
                z = zipfile.ZipFile(io.BytesIO(b))
                for row in csv.reader(io.TextIOWrapper(z.open(z.namelist()[0]))):
                    if row[0] == 'timestamp':
                        continue
                    ts = int(dt.datetime.strptime(row[0], '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
                    last[(ts // BAR * BAR, int(row[1]))] = float(row[3])  # keep the last snapshot of each bar
            except (zipfile.BadZipFile, ValueError):
                continue
            for (tb, pct), notional in last.items():
                i = idx.get(tb)
                if i is None or abs(pct) not in (1, 2, 5):
                    continue
                (bids if pct < 0 else asks)[abs(pct)][i] = notional
    for p in (1, 2, 5):
        with np.errstate(invalid='ignore', divide='ignore'):
            market[f'btc_book_imb{p}'] = (bids[p] - asks[p]) / (bids[p] + asks[p])
        dm, ds = roll_mean(np.log(bids[p] + asks[p])[None], 180)
        market[f'btc_book_depth{p}_z30'] = (np.log(bids[p] + asks[p]) - dm[0]) / ds[0]
    print(f'BTC order book: {np.isfinite(market["btc_book_imb2"]).mean() * 100:.0f}% nến có dữ liệu')

np.savez(D / 'ext.npz', coin=np.stack([coin[k] for k in coin], axis=2).astype(np.float32), coin_names=np.array(list(coin)),
         market=np.stack([market[k] for k in market], axis=1).astype(np.float32), market_names=np.array(list(market)))
print(f'Đã ghi {len(coin)} chỉ báo theo coin + {len(market)} chỉ báo thị trường → {D / "ext.npz"}')
