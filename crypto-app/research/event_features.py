"""Event detection and event-context features shared by training (ml_event.py) and the live bot (live.py).

Both must compute exactly the same numbers, so the code lives here once.
Arrays are [coin, bar]; every value at bar i uses only candles up to and including bar i.
"""
import warnings

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


def roll(a, w, fn):
    out = np.full_like(a, np.nan)
    with np.errstate(invalid='ignore'), warnings.catch_warnings():
        warnings.simplefilter('ignore')
        out[:, w - 1 :] = fn(sliding_window_view(a, w, axis=1), axis=2)
    return out


def roll_std(a, w):
    """Rolling std ignoring NaN, via cumulative sums (memory-light for long 1h panels)."""
    f = np.isfinite(a)
    x = np.where(f, a, 0.0)
    cs = lambda v: np.concatenate([np.zeros((v.shape[0], 1)), np.cumsum(v, axis=1)], axis=1)  # noqa: E731
    k, s1, s2 = cs(f.astype(float)), cs(x), cs(x * x)
    k, s1, s2 = (z[:, w:] - z[:, :-w] for z in (k, s1, s2))
    out = np.full_like(a, np.nan)
    with np.errstate(invalid='ignore', divide='ignore'):
        out[:, w - 1 :] = np.where(k > 1, np.sqrt(np.maximum(s2 / k - (s1 / k) ** 2, 0)), np.nan)
    return out


def detect(Hh, L, CL, side=1, thr=0.05, bpd=6):
    """24h move from the recent high (long) or low (short) and the event mask."""
    hi6, lo6, hi18 = roll(Hh, bpd + 1, np.nanmax), roll(L, bpd + 1, np.nanmin), roll(Hh, 3 * bpd + 1, np.nanmax)
    with np.errstate(invalid='ignore', divide='ignore'):
        drop24 = CL / hi6 - 1  # <= 0
        rise24 = CL / lo6 - 1  # >= 0
    move = drop24 if side > 0 else rise24
    with np.errstate(invalid='ignore'):
        event = (move <= -thr) if side > 0 else (move >= thr)
    return dict(hi6=hi6, lo6=lo6, hi18=hi18, drop24=drop24, rise24=rise24, move=move, event=event)


def context(d, CL, FUND, syms, event, side=1, bpd=6):
    """Event-context features. `d` comes from detect(); `event` is the (possibly extended) event mask."""
    C, n = CL.shape
    k8 = max(1, bpd // 3)  # bars in 8 hours
    drop24, rise24, move = d['drop24'], d['rise24'], d['move']
    with np.errstate(invalid='ignore', divide='ignore'):
        lr = np.log(CL)
        r1 = np.full_like(CL, np.nan)
        r1[:, 1:] = lr[:, 1:] - lr[:, :-1]
        vol30 = roll_std(r1, 30 * bpd)  # 30-day realised per-bar volatility
    btc = syms.index('BTCUSDT')
    with np.errstate(invalid='ignore'), warnings.catch_warnings():
        warnings.simplefilter('ignore')  # bars where no coin traded yet
        med_drop = np.nanmedian(drop24, axis=0)
        med_rise = np.nanmedian(rise24, axis=0)
        breadth_dn = np.nanmean(drop24 <= -0.05, axis=0)
        breadth_up = np.nanmean(rise24 >= 0.05, axis=0)
    since = np.full((C, n), np.nan)
    cap = 1000 * bpd // 6
    for c in range(C):
        last = -10**9
        ev = event[c]
        row = since[c]
        for i in range(n):
            row[i] = min(i - last, cap) / bpd
            if ev[i]:
                last = i
    r_last = np.full_like(CL, np.nan)
    with np.errstate(invalid='ignore', divide='ignore'):
        r_last[:, k8:] = lr[:, k8:] - lr[:, :-k8]
        ctx = {
            'drop24': drop24, 'rise24': rise24, 'drop72': CL / d['hi18'] - 1,
            'ret_4h': r1, 'ret_8h': r_last,
            'move_sigma': move / (vol30 * np.sqrt(bpd)), 'vol30': vol30,
            'btc_drop24': np.broadcast_to(drop24[btc], (C, n)), 'btc_rise24': np.broadcast_to(rise24[btc], (C, n)),
            'med_drop24': np.broadcast_to(med_drop, (C, n)), 'med_rise24': np.broadcast_to(med_rise, (C, n)),
            'rel_move': move - np.broadcast_to(med_drop if side > 0 else med_rise, (C, n)),
            'breadth_dn': np.broadcast_to(breadth_dn, (C, n)), 'breadth_up': np.broadcast_to(breadth_up, (C, n)),
            'funding': FUND, 'days_since_event': since,
            'bounce_from_low': CL / d['lo6'] - 1 if side > 0 else CL / d['hi6'] - 1,
        }
    return ctx


def market_index(CL):
    """Cumulative log return of the median coin (used for the 'market fell another X%' exit)."""
    with np.errstate(invalid='ignore', divide='ignore'), warnings.catch_warnings():
        warnings.simplefilter('ignore')
        r = np.where(np.isfinite(CL[:, 1:] / CL[:, :-1]), np.log(CL[:, 1:] / CL[:, :-1]), np.nan)
        return np.r_[0, np.nancumsum(np.nanmedian(r, axis=0))]
