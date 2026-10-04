// Indicators, strategy families and a bar-by-bar backtest engine.
// Series are column-oriented: { t, o, h, l, c, v } (arrays of equal length).

// ---------- indicators (NaN during warm-up) ----------
const nanArray = (n) => new Array(n).fill(NaN);

export const ema = (v, p) => {
  const out = nanArray(v.length);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = 0;
  for (let j = 0; j < p; j++) prev += v[j];
  prev /= p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
};

export const sma = (v, p) => {
  const out = nanArray(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
};

export const stdev = (v, p, mean) => {
  const out = nanArray(v.length);
  for (let i = p - 1; i < v.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (v[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / p);
  }
  return out;
};

export const rsi = (c, p) => {
  const out = nanArray(c.length);
  if (c.length <= p) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  g /= p;
  l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};

export const atr = (s, p = 14) => {
  const n = s.c.length;
  const out = nanArray(n);
  if (n <= p) return out;
  const tr = (i) =>
    i === 0
      ? s.h[0] - s.l[0]
      : Math.max(s.h[i] - s.l[i], Math.abs(s.h[i] - s.c[i - 1]), Math.abs(s.l[i] - s.c[i - 1]));
  let prev = 0;
  for (let i = 0; i < p; i++) prev += tr(i);
  prev /= p;
  out[p - 1] = prev;
  for (let i = p; i < n; i++) {
    prev = (prev * (p - 1) + tr(i)) / p;
    out[i] = prev;
  }
  return out;
};

// highest high / lowest low of the previous p bars (current bar excluded)
const channel = (s, p) => {
  const hi = nanArray(s.c.length);
  const lo = nanArray(s.c.length);
  for (let i = p; i < s.c.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - p; j < i; j++) {
      if (s.h[j] > h) h = s.h[j];
      if (s.l[j] < l) l = s.l[j];
    }
    hi[i] = h;
    lo[i] = l;
  }
  return { hi, lo };
};

const emaNaN = (v, p) => {
  const start = v.findIndex((x) => !Number.isNaN(x));
  const out = nanArray(v.length);
  if (start < 0) return out;
  const e = ema(v.slice(start), p);
  e.forEach((x, i) => (out[start + i] = x));
  return out;
};

export const macd = (c, fast, slow, signal) => {
  const ef = ema(c, fast);
  const es = ema(c, slow);
  const line = c.map((_, i) => ef[i] - es[i]);
  const sig = emaNaN(line, signal);
  return { line, sig };
};

export const adx = (s, p = 14) => {
  const n = s.c.length;
  const out = nanArray(n);
  if (n <= 2 * p) return out;
  const parts = (i) => {
    const up = s.h[i] - s.h[i - 1];
    const dn = s.l[i - 1] - s.l[i];
    return [
      Math.max(s.h[i] - s.l[i], Math.abs(s.h[i] - s.c[i - 1]), Math.abs(s.l[i] - s.c[i - 1])),
      up > dn && up > 0 ? up : 0,
      dn > up && dn > 0 ? dn : 0,
    ];
  };
  let tr = 0;
  let pd = 0;
  let md = 0;
  for (let i = 1; i <= p; i++) {
    const [a, b, c] = parts(i);
    tr += a;
    pd += b;
    md += c;
  }
  const dx = () => {
    const pdi = (100 * pd) / tr;
    const mdi = (100 * md) / tr;
    return (100 * Math.abs(pdi - mdi)) / (pdi + mdi || 1);
  };
  let sum = dx();
  for (let i = p + 1; i < n; i++) {
    const [a, b, c] = parts(i);
    tr += a - tr / p;
    pd += b - pd / p;
    md += c - md / p;
    const d = dx();
    if (i < 2 * p) sum += d;
    if (i === 2 * p - 1) out[i] = sum / p;
    else if (i >= 2 * p) out[i] = (out[i - 1] * (p - 1) + d) / p;
  }
  return out;
};

// direction of the Supertrend line: +1 up-trend / -1 down-trend (0 during warm-up)
export const supertrend = (s, period, mult) => {
  const n = s.c.length;
  const a = atr(s, period);
  const dir = new Int8Array(n);
  let fu = NaN;
  let fl = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    const mid = (s.h[i] + s.l[i]) / 2;
    const upper = mid + mult * a[i];
    const lower = mid - mult * a[i];
    if (Number.isNaN(fu)) {
      fu = upper;
      fl = lower;
      dir[i] = 1;
      continue;
    }
    const prevClose = s.c[i - 1];
    fu = upper < fu || prevClose > fu ? upper : fu;
    fl = lower > fl || prevClose < fl ? lower : fl;
    dir[i] = dir[i - 1];
    if (dir[i - 1] === 1 && s.c[i] < fl) dir[i] = -1;
    else if (dir[i - 1] === -1 && s.c[i] > fu) dir[i] = 1;
  }
  return dir;
};

// ---------- strategy families ----------
// signals() -> Int8Array: +1 long / -1 short / 0 none, decided at the CLOSE of bar i.
// The engine enters at the OPEN of bar i+1, so there is no look-ahead.
const cartesian = (spec) =>
  Object.entries(spec).reduce(
    (acc, [key, values]) => acc.flatMap((a) => values.map((v) => ({ ...a, [key]: v }))),
    [{}],
  );

const adxOk = (a, i, min) => min === 0 || a[i] >= min;

export const STRATEGIES = {
  emaCross: {
    label: 'EMA cross (trend)',
    grid: cartesian({ fast: [8, 12, 20, 26], slow: [30, 50, 100, 200], adxMin: [0, 20, 25] }).filter((p) => p.fast < p.slow),
    signals(s, p) {
      const f = ema(s.c, p.fast);
      const sl = ema(s.c, p.slow);
      const a = adx(s, 14);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        if (!adxOk(a, i, p.adxMin)) continue;
        if (f[i - 1] <= sl[i - 1] && f[i] > sl[i]) out[i] = 1;
        else if (f[i - 1] >= sl[i - 1] && f[i] < sl[i]) out[i] = -1;
      }
      return out;
    },
  },
  macd: {
    label: 'MACD cross (trend)',
    grid: cartesian({ fast: [8, 12], slow: [21, 26, 35], signal: [9], zero: [0, 1] }),
    signals(s, p) {
      const { line, sig } = macd(s.c, p.fast, p.slow, p.signal);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        if (line[i - 1] <= sig[i - 1] && line[i] > sig[i] && (!p.zero || line[i] > 0)) out[i] = 1;
        else if (line[i - 1] >= sig[i - 1] && line[i] < sig[i] && (!p.zero || line[i] < 0)) out[i] = -1;
      }
      return out;
    },
  },
  supertrend: {
    label: 'Supertrend (trend)',
    grid: cartesian({ period: [10, 14, 20], mult: [2, 3, 4] }),
    signals(s, p) {
      const d = supertrend(s, p.period, p.mult);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) if (d[i] !== 0 && d[i - 1] !== 0 && d[i] !== d[i - 1]) out[i] = d[i];
      return out;
    },
  },
  donchian: {
    label: 'Donchian breakout (trend)',
    grid: cartesian({ period: [20, 30, 40, 55, 80], adxMin: [0, 20, 25] }),
    signals(s, p) {
      const { hi, lo } = channel(s, p.period);
      const a = adx(s, 14);
      const out = new Int8Array(s.c.length);
      for (let i = 0; i < out.length; i++) {
        if (!adxOk(a, i, p.adxMin)) continue;
        if (s.c[i] > hi[i]) out[i] = 1;
        else if (s.c[i] < lo[i]) out[i] = -1;
      }
      return out;
    },
  },
  trendPullback: {
    label: 'Trend + RSI pullback',
    grid: cartesian({ trendEma: [100, 200], rsiPeriod: [7, 14], level: [30, 40, 45] }),
    signals(s, p) {
      const e = ema(s.c, p.trendEma);
      const r = rsi(s.c, p.rsiPeriod);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        if (s.c[i] > e[i] && r[i - 1] < p.level && r[i] >= p.level) out[i] = 1;
        else if (s.c[i] < e[i] && r[i - 1] > 100 - p.level && r[i] <= 100 - p.level) out[i] = -1;
      }
      return out;
    },
  },
  squeeze: {
    label: 'Volatility squeeze breakout',
    grid: cartesian({ rank: [0.1, 0.2], brk: [20, 40] }),
    signals(s, p) {
      const L = 120;
      const mid = sma(s.c, 20);
      const sd = stdev(s.c, 20, mid);
      const bw = s.c.map((_, i) => (4 * sd[i]) / mid[i]);
      const squeezed = new Uint8Array(s.c.length);
      for (let i = L + 20; i < s.c.length; i++) {
        let below = 0;
        for (let j = i - L; j < i; j++) if (bw[j] < bw[i]) below++;
        squeezed[i] = below / L <= p.rank ? 1 : 0;
      }
      const { hi, lo } = channel(s, p.brk);
      const out = new Int8Array(s.c.length);
      for (let i = 6; i < out.length; i++) {
        let recent = 0;
        for (let j = i - 5; j < i; j++) recent |= squeezed[j];
        if (!recent) continue;
        if (s.c[i] > hi[i]) out[i] = 1;
        else if (s.c[i] < lo[i]) out[i] = -1;
      }
      return out;
    },
  },
  rsiReversion: {
    label: 'RSI mean-reversion',
    grid: cartesian({ period: [7, 14], lo: [20, 25, 30], hi: [70, 75, 80], withTrend: [0, 1] }),
    signals(s, p) {
      const r = rsi(s.c, p.period);
      const e = ema(s.c, 200);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        if (r[i - 1] < p.lo && r[i] >= p.lo && (!p.withTrend || s.c[i] > e[i])) out[i] = 1;
        else if (r[i - 1] > p.hi && r[i] <= p.hi && (!p.withTrend || s.c[i] < e[i])) out[i] = -1;
      }
      return out;
    },
  },
  bbReversion: {
    label: 'Bollinger mean-reversion',
    grid: cartesian({ period: [20, 30], k: [2, 2.5, 3], withTrend: [0, 1] }),
    signals(s, p) {
      const mid = sma(s.c, p.period);
      const sd = stdev(s.c, p.period, mid);
      const e = ema(s.c, 200);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        const lowerPrev = mid[i - 1] - p.k * sd[i - 1];
        const upperPrev = mid[i - 1] + p.k * sd[i - 1];
        if (s.c[i - 1] < lowerPrev && s.c[i] >= mid[i] - p.k * sd[i] && (!p.withTrend || s.c[i] > e[i])) out[i] = 1;
        else if (s.c[i - 1] > upperPrev && s.c[i] <= mid[i] + p.k * sd[i] && (!p.withTrend || s.c[i] < e[i])) out[i] = -1;
      }
      return out;
    },
  },
};

// Exit styles (ATR multiples): fixed stop + optional target, or a trailing stop.
// tpMult 0 and no trail = exit only on the opposite signal.
export const EXIT_GRID = [
  ...cartesian({ slMult: [1.5, 2.5, 3.5], tpMult: [0, 2, 4] }).map((e) => ({ ...e, trail: false })),
  ...cartesian({ slMult: [2, 3, 4], tpMult: [0] }).map((e) => ({ ...e, trail: true })),
];

// ---------- engine ----------
export const MARKETS = {
  spot: { fee: 0.001, slippage: 0.0002, allowShort: false, maxLeverage: 1 },
  futures: { fee: 0.0005, slippage: 0.0002, allowShort: true, maxLeverage: 3 },
};

export const WARMUP = 210;
const RISK_PER_TRADE = 0.01; // 1% of equity risked at the stop

// Trade bars [from, to). Signal of bar i-1 -> entry at open of bar i.
export const runBacktest = (s, sig, atrArr, exits, market, from, to, curve = null, tradesOut = null) => {
  const m = MARKETS[market];
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  let pos = null;
  let wins = 0;
  let trades = 0;
  let grossWin = 0;
  let grossLoss = 0;

  const close = (price, i) => {
    const px = price * (1 - pos.dir * m.slippage);
    const pnl = (pos.dir * (px - pos.entry)) / pos.entry * pos.notional - pos.notional * m.fee * 2 - pos.funding;
    equity += pnl;
    trades++;
    if (tradesOut) tradesOut.push(pnl / pos.eq0);
    if (pnl > 0) {
      wins++;
      grossWin += pnl;
    } else grossLoss -= pnl;
    pos = null;
    return i;
  };

  for (let i = Math.max(from, WARMUP); i < to; i++) {
    const prevSig = sig[i - 1];

    if (pos && prevSig === -pos.dir) close(s.o[i], i);

    if (!pos && prevSig !== 0 && (prevSig === 1 || m.allowShort) && atrArr[i - 1] > 0) {
      const dir = prevSig;
      const entry = s.o[i] * (1 + dir * m.slippage);
      const dist = exits.slMult * atrArr[i - 1];
      const slPct = dist / entry;
      const notional = Math.min((equity * RISK_PER_TRADE) / slPct, equity * m.maxLeverage);
      pos = {
        dir,
        entry,
        notional,
        dist,
        eq0: equity,
        funding: 0,
        extreme: entry,
        sl: entry - dir * dist,
        tp: exits.tpMult > 0 ? entry + dir * exits.tpMult * atrArr[i - 1] : null,
      };
    }

    // funding: longs pay a positive rate, shorts receive it (futures only)
    if (pos && m.allowShort && s.fund && Number.isFinite(s.fund[i])) pos.funding += pos.dir * s.fund[i] * pos.notional;

    if (pos) {
      // trailing stop follows the extreme of PREVIOUS bars only
      if (exits.trail) pos.sl = pos.dir === 1 ? Math.max(pos.sl, pos.extreme - pos.dist) : Math.min(pos.sl, pos.extreme + pos.dist);
      // stop is checked first: conservative when both levels sit inside one bar
      if (pos.dir === 1) {
        if (s.l[i] <= pos.sl) close(Math.min(pos.sl, s.o[i]), i);
        else if (pos.tp !== null && s.h[i] >= pos.tp) close(pos.tp, i);
      } else if (s.h[i] >= pos.sl) close(Math.max(pos.sl, s.o[i]), i);
      else if (pos.tp !== null && s.l[i] <= pos.tp) close(pos.tp, i);
      if (pos) pos.extreme = pos.dir === 1 ? Math.max(pos.extreme, s.h[i]) : Math.min(pos.extreme, s.l[i]);
    }

    const mtm = pos ? equity + (pos.dir * (s.c[i] - pos.entry)) / pos.entry * pos.notional - pos.funding : equity;
    if (curve) curve[i] = mtm;
    if (mtm > peak) peak = mtm;
    maxDD = Math.max(maxDD, (peak - mtm) / peak);
  }
  if (pos) close(s.c[to - 1], to - 1);

  const ret = (equity - 1) * 100;
  const dd = maxDD * 100;
  return {
    trades,
    winRate: trades ? (wins / trades) * 100 : 0,
    ret,
    maxDD: dd,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    score: ret - 1.5 * dd,
  };
};

export const buyAndHold = (s, from, to) => {
  const a = Math.max(from, WARMUP);
  return (s.c[to - 1] / s.o[a] - 1) * 100;
};
