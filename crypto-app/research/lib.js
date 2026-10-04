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

// ---------- strategy families ----------
// signals() -> Int8Array: +1 long / -1 short / 0 none, decided at the CLOSE of bar i.
// The engine enters at the OPEN of bar i+1, so there is no look-ahead.
const cartesian = (spec) =>
  Object.entries(spec).reduce(
    (acc, [key, values]) => acc.flatMap((a) => values.map((v) => ({ ...a, [key]: v }))),
    [{}],
  );

export const STRATEGIES = {
  emaCross: {
    label: 'EMA cross (trend)',
    grid: cartesian({ fast: [8, 12, 20, 26], slow: [30, 50, 100, 200] }).filter((p) => p.fast < p.slow),
    signals(s, p) {
      const f = ema(s.c, p.fast);
      const sl = ema(s.c, p.slow);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        if (f[i - 1] <= sl[i - 1] && f[i] > sl[i]) out[i] = 1;
        else if (f[i - 1] >= sl[i - 1] && f[i] < sl[i]) out[i] = -1;
      }
      return out;
    },
  },
  donchian: {
    label: 'Donchian breakout (trend)',
    grid: cartesian({ period: [20, 30, 40, 55, 80] }),
    signals(s, p) {
      const { hi, lo } = channel(s, p.period);
      const out = new Int8Array(s.c.length);
      for (let i = 0; i < out.length; i++) {
        if (s.c[i] > hi[i]) out[i] = 1;
        else if (s.c[i] < lo[i]) out[i] = -1;
      }
      return out;
    },
  },
  rsiReversion: {
    label: 'RSI mean-reversion',
    grid: cartesian({ period: [7, 14], lo: [20, 25, 30], hi: [70, 75, 80] }),
    signals(s, p) {
      const r = rsi(s.c, p.period);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        if (r[i - 1] < p.lo && r[i] >= p.lo) out[i] = 1;
        else if (r[i - 1] > p.hi && r[i] <= p.hi) out[i] = -1;
      }
      return out;
    },
  },
  bbReversion: {
    label: 'Bollinger mean-reversion',
    grid: cartesian({ period: [20, 30], k: [2, 2.5, 3] }),
    signals(s, p) {
      const mid = sma(s.c, p.period);
      const sd = stdev(s.c, p.period, mid);
      const out = new Int8Array(s.c.length);
      for (let i = 1; i < out.length; i++) {
        const lowerPrev = mid[i - 1] - p.k * sd[i - 1];
        const upperPrev = mid[i - 1] + p.k * sd[i - 1];
        if (s.c[i - 1] < lowerPrev && s.c[i] >= mid[i] - p.k * sd[i]) out[i] = 1;
        else if (s.c[i - 1] > upperPrev && s.c[i] <= mid[i] + p.k * sd[i]) out[i] = -1;
      }
      return out;
    },
  },
};

// stop / take-profit multiples of ATR (tp 0 = no target, exit on opposite signal)
export const EXIT_GRID = cartesian({ slMult: [1.5, 2.5], tpMult: [0, 2, 4] });

// ---------- engine ----------
export const MARKETS = {
  spot: { fee: 0.001, slippage: 0.0002, allowShort: false, maxLeverage: 1 },
  futures: { fee: 0.0005, slippage: 0.0002, allowShort: true, maxLeverage: 3 },
};

export const WARMUP = 210;
const RISK_PER_TRADE = 0.01; // 1% of equity risked at the stop

// Trade bars [from, to). Signal of bar i-1 -> entry at open of bar i.
export const runBacktest = (s, sig, atrArr, exits, market, from, to) => {
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
    const pnl = (pos.dir * (px - pos.entry)) / pos.entry * pos.notional - pos.notional * m.fee * 2;
    equity += pnl;
    trades++;
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
        sl: entry - dir * dist,
        tp: exits.tpMult > 0 ? entry + dir * exits.tpMult * atrArr[i - 1] : null,
      };
    }

    if (pos) {
      // stop is checked first: conservative when both levels sit inside one bar
      if (pos.dir === 1) {
        if (s.l[i] <= pos.sl) close(Math.min(pos.sl, s.o[i]), i);
        else if (pos.tp !== null && s.h[i] >= pos.tp) close(pos.tp, i);
      } else if (s.h[i] >= pos.sl) close(Math.max(pos.sl, s.o[i]), i);
      else if (pos.tp !== null && s.l[i] <= pos.tp) close(pos.tp, i);
    }

    const mtm = pos ? equity + (pos.dir * (s.c[i] - pos.entry)) / pos.entry * pos.notional : equity;
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
