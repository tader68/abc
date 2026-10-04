// Indicator library: ~300 causal feature series per symbol, each turned into a rolling
// percentile rank (0..100) so rules can use adaptive thresholds ("RSI in its top 10% of the
// last 300 bars") instead of fixed levels. Every value at bar i only uses data up to bar i.
import { ema, sma, stdev, rsi, atr, adx, macd } from './lib.js';

export const RANK_WINDOW = 300;
const NA = 255;

const arr = (n) => new Float64Array(n).fill(NaN);
const each = (n, from, f) => {
  const out = arr(n);
  for (let i = from; i < n; i++) out[i] = f(i);
  return out;
};
const lag = (x, k) => each(x.length, k, (i) => x[i - k]);
const diff = (x, k) => each(x.length, k, (i) => x[i] - x[i - k]);
const logRet = (c, k) => each(c.length, k, (i) => Math.log(c[i] / c[i - k]));
const rollSum = (x, p) => {
  const out = arr(x.length);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) bad++;
    else sum += x[i];
    if (i >= p) {
      if (Number.isNaN(x[i - p])) bad--;
      else sum -= x[i - p];
    }
    if (i >= p - 1 && bad === 0) out[i] = sum;
  }
  return out;
};
const rollMax = (x, p) => each(x.length, p - 1, (i) => {
  let m = -Infinity;
  for (let j = i - p + 1; j <= i; j++) if (x[j] > m) m = x[j];
  return m;
});
const rollMin = (x, p) => each(x.length, p - 1, (i) => {
  let m = Infinity;
  for (let j = i - p + 1; j <= i; j++) if (x[j] < m) m = x[j];
  return m;
});
const zscore = (x, p) => {
  const m = sma(x, p);
  const sd = stdev(x, p, m);
  return each(x.length, 0, (i) => (x[i] - m[i]) / (sd[i] || NaN));
};
const wma = (x, p) => {
  const out = arr(x.length);
  const den = (p * (p + 1)) / 2;
  for (let i = p - 1; i < x.length; i++) {
    let s = 0;
    for (let j = 0; j < p; j++) s += x[i - j] * (p - j);
    out[i] = s / den;
  }
  return out;
};
const hma = (x, p) => {
  const half = wma(x, Math.max(2, Math.round(p / 2)));
  const full = wma(x, p);
  const raw = x.map((_, i) => 2 * half[i] - full[i]);
  return wma(raw, Math.max(2, Math.round(Math.sqrt(p))));
};
// least-squares line over the last p points: slope per bar (relative to price) and R^2
const linreg = (c, p) => {
  const slope = arr(c.length);
  const r2 = arr(c.length);
  const xm = (p - 1) / 2;
  let sxx = 0;
  for (let j = 0; j < p; j++) sxx += (j - xm) ** 2;
  for (let i = p - 1; i < c.length; i++) {
    let ym = 0;
    for (let j = 0; j < p; j++) ym += c[i - p + 1 + j];
    ym /= p;
    let sxy = 0;
    let syy = 0;
    for (let j = 0; j < p; j++) {
      const dy = c[i - p + 1 + j] - ym;
      sxy += (j - xm) * dy;
      syy += dy * dy;
    }
    slope[i] = sxy / sxx / c[i];
    r2[i] = syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN;
  }
  return { slope, r2 };
};

// ---------- causal percentile rank over a sliding window ----------
export const rollingRank = (x, W = RANK_WINDOW) => {
  const n = x.length;
  const out = new Uint8Array(n).fill(NA);
  const win = new Float64Array(W);
  let cnt = 0;
  const lowerBound = (v) => {
    let lo = 0;
    let hi = cnt;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (win[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let i = 0; i < n; i++) {
    if (i >= W && Number.isFinite(x[i - W])) {
      const p = lowerBound(x[i - W]);
      win.copyWithin(p, p + 1, cnt);
      cnt--;
    }
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    const p = lowerBound(v);
    win.copyWithin(p + 1, p, cnt);
    win[p] = v;
    cnt++;
    if (cnt >= 60) out[i] = Math.round((100 * p) / (cnt - 1));
  }
  return out;
};

// ---------- the library ----------
// ctx.btc: BTC series aligned bar-for-bar with s (enables cross-asset features).
export const buildFeatureSeries = (s, ctx = {}) => {
  const { o, h, l, c, v } = s;
  const n = c.length;
  const F = [];
  const add = (id, series) => F.push({ id, series });
  const hasFlow = Array.isArray(s.tb) && s.tb.length === n;
  const atr14 = atr(s, 14);

  // returns / momentum
  for (const k of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]) add(`ret${k}`, logRet(c, k));
  const r1 = logRet(c, 1);
  for (const k of [2, 3, 5, 8, 13]) add(`retSkipLast${k}`, each(n, k + 1, (i) => Math.log(c[i - 1] / c[i - 1 - k])));

  // distance to moving averages (several smoothers)
  for (const p of [5, 8, 13, 21, 34, 55, 89, 144, 233]) {
    const e = ema(c, p);
    add(`emaDist${p}`, each(n, 0, (i) => c[i] / e[i] - 1));
  }
  for (const p of [10, 20, 50, 100, 200]) {
    const m = sma(c, p);
    add(`smaDist${p}`, each(n, 0, (i) => c[i] / m[i] - 1));
  }
  for (const p of [9, 21, 55]) {
    const w = wma(c, p);
    add(`wmaDist${p}`, each(n, 0, (i) => c[i] / w[i] - 1));
    const hm = hma(c, p);
    add(`hmaDist${p}`, each(n, 0, (i) => c[i] / hm[i] - 1));
    add(`hmaSlope${p}`, each(n, 0, (i) => (Number.isFinite(hm[i - 2]) ? hm[i] / hm[i - 2] - 1 : NaN)));
  }
  for (const p of [8, 21, 55, 100]) {
    const e = ema(c, p);
    add(`emaSlope${p}`, each(n, 3, (i) => e[i] / e[i - 3] - 1));
  }
  for (const [a, b] of [[8, 21], [12, 26], [21, 55], [20, 100], [50, 200], [5, 34]]) {
    const ea = ema(c, a);
    const eb = ema(c, b);
    add(`emaSpread${a}_${b}`, each(n, 0, (i) => ea[i] / eb[i] - 1));
  }
  for (const p of [10, 20, 50, 100]) add(`zscore${p}`, zscore(c, p));

  // regression
  for (const p of [10, 20, 50, 100]) {
    const { slope, r2 } = linreg(c, p);
    add(`linSlope${p}`, slope);
    add(`linR2${p}`, r2);
    add(`linTrendQuality${p}`, each(n, 0, (i) => slope[i] * r2[i]));
  }

  // trend strength / structure
  for (const p of [14, 28]) {
    add(`adx${p}`, adx(s, p));
  }
  for (const p of [14, 28]) {
    // +DI - -DI
    const out = arr(n);
    let tr = 0;
    let pd = 0;
    let md = 0;
    for (let i = 1; i < n; i++) {
      const up = h[i] - h[i - 1];
      const dn = l[i - 1] - l[i];
      const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      tr += t - tr / p;
      pd += (up > dn && up > 0 ? up : 0) - pd / p;
      md += (dn > up && dn > 0 ? dn : 0) - md / p;
      if (i >= p) out[i] = (100 * (pd - md)) / (tr || NaN);
    }
    add(`diSpread${p}`, out);
  }
  for (const p of [14, 25, 50]) {
    add(`aroonOsc${p}`, each(n, p, (i) => {
      let hi = i;
      let lo = i;
      for (let j = i - p; j <= i; j++) {
        if (h[j] >= h[hi]) hi = j;
        if (l[j] <= l[lo]) lo = j;
      }
      return (100 * ((i - lo) - (i - hi))) / p;
    }));
  }
  for (const p of [14, 28]) {
    const vp = each(n, 1, (i) => Math.abs(h[i] - l[i - 1]));
    const vm = each(n, 1, (i) => Math.abs(l[i] - h[i - 1]));
    const tr = each(n, 1, (i) => Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const a = rollSum(vp, p);
    const b = rollSum(vm, p);
    const t = rollSum(tr, p);
    add(`vortex${p}`, each(n, 0, (i) => (a[i] - b[i]) / t[i]));
  }
  for (const p of [10, 20, 50]) {
    add(`efficiency${p}`, each(n, p, (i) => {
      let path = 0;
      for (let j = i - p + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
      return path > 0 ? Math.abs(c[i] - c[i - p]) / path : NaN;
    }));
  }
  for (const p of [14, 28]) {
    const tr = each(n, 1, (i) => Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const st = rollSum(tr, p);
    const hh = rollMax(h, p);
    const ll = rollMin(l, p);
    add(`choppiness${p}`, each(n, 0, (i) => (100 * Math.log10(st[i] / (hh[i] - ll[i]))) / Math.log10(p)));
  }
  {
    const hh9 = rollMax(h, 9);
    const ll9 = rollMin(l, 9);
    const hh26 = rollMax(h, 26);
    const ll26 = rollMin(l, 26);
    const hh52 = rollMax(h, 52);
    const ll52 = rollMin(l, 52);
    const tenkan = each(n, 0, (i) => (hh9[i] + ll9[i]) / 2);
    const kijun = each(n, 0, (i) => (hh26[i] + ll26[i]) / 2);
    const spanB = each(n, 0, (i) => (hh52[i] + ll52[i]) / 2);
    add('ichiTenkanKijun', each(n, 0, (i) => (tenkan[i] - kijun[i]) / c[i]));
    add('ichiCloudPos', each(n, 0, (i) => (c[i] - (kijun[i] + spanB[i]) / 2) / c[i]));
    add('ichiPriceKijun', each(n, 0, (i) => (c[i] - kijun[i]) / c[i]));
  }

  // oscillators
  for (const p of [2, 3, 5, 7, 9, 14, 21, 28]) add(`rsi${p}`, rsi(c, p));
  for (const p of [5, 9, 14, 21]) {
    const hh = rollMax(h, p);
    const ll = rollMin(l, p);
    const k = each(n, 0, (i) => (100 * (c[i] - ll[i])) / (hh[i] - ll[i] || NaN));
    add(`stochK${p}`, k);
    add(`stochKD${p}`, each(n, 0, (i) => k[i] - (k[i - 1] + k[i - 2]) / 3));
  }
  {
    const r = rsi(c, 14);
    const hh = rollMax(r.map((x) => (Number.isNaN(x) ? -Infinity : x)), 14);
    const ll = rollMin(r.map((x) => (Number.isNaN(x) ? Infinity : x)), 14);
    add('stochRsi14', each(n, 0, (i) => (Number.isFinite(hh[i]) && Number.isFinite(ll[i]) && hh[i] > ll[i] ? (r[i] - ll[i]) / (hh[i] - ll[i]) : NaN)));
  }
  for (const p of [14, 20, 50]) {
    const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3);
    const m = sma(tp, p);
    add(`cci${p}`, each(n, p - 1, (i) => {
      let md = 0;
      for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= p;
      return md > 0 ? (tp[i] - m[i]) / (0.015 * md) : NaN;
    }));
  }
  for (const p of [9, 14]) {
    add(`cmo${p}`, each(n, p, (i) => {
      let up = 0;
      let dn = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const d = c[j] - c[j - 1];
        if (d > 0) up += d;
        else dn -= d;
      }
      return up + dn > 0 ? (100 * (up - dn)) / (up + dn) : NaN;
    }));
  }
  for (const [f, sl, sg] of [[12, 26, 9], [8, 21, 5], [5, 35, 5], [19, 39, 9]]) {
    const { line, sig } = macd(c, f, sl, sg);
    add(`macdHist${f}_${sl}`, each(n, 0, (i) => (line[i] - sig[i]) / c[i]));
    add(`macdLine${f}_${sl}`, each(n, 0, (i) => line[i] / c[i]));
  }
  for (const p of [9, 15]) {
    const e3 = ema(ema(ema(c.map(Math.log), p).map((x) => (Number.isNaN(x) ? NaN : x)), p), p);
    add(`trix${p}`, each(n, 1, (i) => (e3[i] - e3[i - 1]) * 100));
  }
  {
    const hl2 = c.map((_, i) => (h[i] + l[i]) / 2);
    const a5 = sma(hl2, 5);
    const a34 = sma(hl2, 34);
    add('awesomeOsc', each(n, 0, (i) => (a5[i] - a34[i]) / c[i]));
  }
  for (const p of [14, 20]) {
    const m = sma(c, p);
    const sh = Math.floor(p / 2) + 1;
    add(`dpo${p}`, each(n, sh, (i) => (c[i] - m[i - sh]) / c[i]));
  }

  // volatility
  for (const p of [7, 14, 28, 56]) {
    const a = atr(s, p);
    add(`atrPct${p}`, each(n, 0, (i) => a[i] / c[i]));
  }
  {
    const a7 = atr(s, 7);
    const a28 = atr(s, 28);
    const a56 = atr(s, 56);
    add('atrRatio7_28', each(n, 0, (i) => a7[i] / a28[i]));
    add('atrRatio14_56', each(n, 0, (i) => atr14[i] / a56[i]));
  }
  for (const p of [20, 50]) {
    const m = sma(c, p);
    const sd = stdev(c, p, m);
    add(`bbPctB${p}`, each(n, 0, (i) => (c[i] - (m[i] - 2 * sd[i])) / (4 * sd[i] || NaN)));
    add(`bbWidth${p}`, each(n, 0, (i) => (4 * sd[i]) / m[i]));
  }
  for (const p of [20, 50]) {
    const e = ema(c, p);
    add(`keltnerPos${p}`, each(n, 0, (i) => (c[i] - e[i]) / (2 * atr14[i] || NaN)));
  }
  for (const p of [10, 20, 55, 100]) {
    const hh = rollMax(h, p);
    const ll = rollMin(l, p);
    add(`donchianPos${p}`, each(n, 0, (i) => (c[i] - ll[i]) / (hh[i] - ll[i] || NaN)));
    add(`distHigh${p}`, each(n, 0, (i) => c[i] / hh[i] - 1));
    add(`distLow${p}`, each(n, 0, (i) => c[i] / ll[i] - 1));
  }
  for (const p of [10, 20, 50]) {
    const sd = stdev(r1.map((x) => (Number.isNaN(x) ? 0 : x)), p, sma(r1.map((x) => (Number.isNaN(x) ? 0 : x)), p));
    add(`realizedVol${p}`, sd);
  }
  add('volRatio10_50', (() => {
    const z = r1.map((x) => (Number.isNaN(x) ? 0 : x));
    const a = stdev(z, 10, sma(z, 10));
    const b = stdev(z, 50, sma(z, 50));
    return each(n, 0, (i) => a[i] / b[i]);
  })());
  for (const p of [10, 20]) {
    add(`parkinson${p}`, (() => {
      const q = c.map((_, i) => Math.log(h[i] / l[i]) ** 2);
      const m = sma(q, p);
      return each(n, 0, (i) => Math.sqrt(m[i] / (4 * Math.log(2))));
    })());
  }
  for (const p of [20, 50]) {
    add(`skew${p}`, each(n, p, (i) => {
      let m = 0;
      for (let j = i - p + 1; j <= i; j++) m += r1[j];
      m /= p;
      let s2 = 0;
      let s3 = 0;
      for (let j = i - p + 1; j <= i; j++) {
        s2 += (r1[j] - m) ** 2;
        s3 += (r1[j] - m) ** 3;
      }
      const sd = Math.sqrt(s2 / p);
      return sd > 0 ? s3 / p / sd ** 3 : NaN;
    }));
  }
  add('rangeExpansion', each(n, 1, (i) => (h[i] - l[i]) / atr14[i - 1]));
  for (const p of [1, 3, 5]) {
    const clv = c.map((_, i) => (c[i] - l[i]) / (h[i] - l[i] || NaN));
    add(`closeInRange${p}`, p === 1 ? clv : sma(clv, p));
  }

  // candle shape
  for (const p of [1, 3]) {
    const body = c.map((_, i) => (c[i] - o[i]) / (h[i] - l[i] || NaN));
    const up = c.map((_, i) => (h[i] - Math.max(o[i], c[i])) / (h[i] - l[i] || NaN));
    const dn = c.map((_, i) => (Math.min(o[i], c[i]) - l[i]) / (h[i] - l[i] || NaN));
    add(`candleBody${p}`, p === 1 ? body : sma(body, p));
    add(`upperWick${p}`, p === 1 ? up : sma(up, p));
    add(`lowerWick${p}`, p === 1 ? dn : sma(dn, p));
  }
  add('gapAtr', each(n, 1, (i) => (o[i] - c[i - 1]) / atr14[i]));
  add('upStreak', each(n, 10, (i) => {
    let k = 0;
    while (k < 10 && c[i - k] > c[i - k - 1]) k++;
    return k;
  }));
  add('downStreak', each(n, 10, (i) => {
    let k = 0;
    while (k < 10 && c[i - k] < c[i - k - 1]) k++;
    return k;
  }));

  // volume / order flow
  const lv = v.map((x) => Math.log(x + 1));
  for (const p of [20, 50]) add(`volZ${p}`, zscore(lv, p));
  for (const p of [10, 20, 50]) {
    const m = sma(v, p);
    add(`volRatio${p}`, each(n, 0, (i) => v[i] / m[i]));
  }
  {
    const obv = arr(n);
    obv[0] = 0;
    for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);
    for (const p of [10, 20, 50]) {
      const sv = rollSum(v, p);
      add(`obvSlope${p}`, each(n, p, (i) => (obv[i] - obv[i - p]) / sv[i]));
    }
  }
  {
    const clv = c.map((_, i) => ((c[i] - l[i]) - (h[i] - c[i])) / (h[i] - l[i] || NaN));
    for (const p of [10, 20]) {
      const a = rollSum(clv.map((x, i) => x * v[i]), p);
      const b = rollSum(v, p);
      add(`cmf${p}`, each(n, 0, (i) => a[i] / b[i]));
    }
  }
  for (const p of [7, 14, 21]) {
    const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3);
    const pos = each(n, 1, (i) => (tp[i] > tp[i - 1] ? tp[i] * v[i] : 0));
    const neg = each(n, 1, (i) => (tp[i] < tp[i - 1] ? tp[i] * v[i] : 0));
    const a = rollSum(pos, p);
    const b = rollSum(neg, p);
    add(`mfi${p}`, each(n, 0, (i) => 100 - 100 / (1 + a[i] / (b[i] || NaN))));
  }
  for (const p of [20, 50, 100, 200]) {
    const a = rollSum(c.map((x, i) => x * v[i]), p);
    const b = rollSum(v, p);
    add(`vwapDev${p}`, each(n, 0, (i) => c[i] / (a[i] / b[i]) - 1));
  }
  for (const p of [2, 13]) {
    const fi = each(n, 1, (i) => ((c[i] - c[i - 1]) * v[i]) / (v[i] + 1));
    const fe = ema(fi.map((x) => (Number.isNaN(x) ? 0 : x)), p);
    add(`forceIndex${p}`, each(n, 0, (i) => fe[i] / c[i]));
  }
  if (hasFlow) {
    const tbr = c.map((_, i) => s.tb[i] / (v[i] || NaN));
    for (const p of [1, 3, 8, 21]) add(`takerBuyRatio${p}`, p === 1 ? tbr : ema(tbr.map((x) => (Number.isNaN(x) ? 0.5 : x)), p));
    add('takerBuyZ20', zscore(tbr, 20));
    const nt = Array.isArray(s.nt) ? s.nt.map((x) => Math.log(x + 1)) : null;
    if (nt) {
      add('tradeCountZ20', zscore(nt, 20));
      add('avgTradeSizeZ20', zscore(c.map((_, i) => Math.log((v[i] + 1) / (s.nt[i] + 1))), 20));
    }
    const delta = c.map((_, i) => (2 * s.tb[i] - v[i]) / (v[i] || NaN));
    for (const p of [5, 20]) {
      const a = rollSum(delta.map((x, i) => x * v[i]), p);
      const b = rollSum(v, p);
      add(`cumDelta${p}`, each(n, 0, (i) => a[i] / b[i]));
    }
  }

  // cross-asset: BTC regime and relative strength
  if (ctx.btc) {
    const bc = ctx.btc.c;
    for (const k of [8, 24, 72]) {
      const br = logRet(bc, k);
      const sr = logRet(c, k);
      add(`btcRet${k}`, br);
      add(`relStrength${k}`, each(n, k, (i) => sr[i] - br[i]));
    }
    for (const p of [21, 55, 144]) {
      const e = ema(bc, p);
      add(`btcEmaDist${p}`, each(n, 0, (i) => bc[i] / e[i] - 1));
    }
    {
      const z = logRet(bc, 1).map((x) => (Number.isNaN(x) ? 0 : x));
      const sd = stdev(z, 20, sma(z, 20));
      add('btcVol20', sd);
    }
    const br1 = logRet(bc, 1);
    for (const p of [30, 90]) {
      add(`btcCorr${p}`, each(n, p, (i) => {
        let ma = 0;
        let mb = 0;
        for (let j = i - p + 1; j <= i; j++) {
          ma += r1[j];
          mb += br1[j];
        }
        ma /= p;
        mb /= p;
        let sab = 0;
        let saa = 0;
        let sbb = 0;
        for (let j = i - p + 1; j <= i; j++) {
          sab += (r1[j] - ma) * (br1[j] - mb);
          saa += (r1[j] - ma) ** 2;
          sbb += (br1[j] - mb) ** 2;
        }
        return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
      }));
    }
  }

  // sanity: lag-1 versions of a few fast features add "what just happened" context
  add('ret1Lag1', lag(r1, 1));
  add('rsi14Delta3', (() => {
    const r = rsi(c, 14);
    return diff(r, 3);
  })());
  return F;
};

export const rankSeries = (series) => series.map(({ id, series: x }) => ({ id, rank: rollingRank(x) }));
