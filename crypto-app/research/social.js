#!/usr/bin/env node
// Popular setups shared on TradingView / YouTube / social media, coded as described and tested on
// BTC, ETH, SOL (Binance, 5m data aggregated) since 2021 with futures fees + slippage:
//   1. Triple Supertrend + RSI + EMA200 (1h): long above EMA200 when ≥2/3 Supertrends are green and
//      RSI < 40; short mirrored; stop 1×ATR, target 1.5×ATR
//   2. EMA 20/50/200 (1h): long when EMA20 crosses above EMA50 above EMA200, short mirrored, exit on
//      the opposite cross
//   3. RSI + Bollinger scalping (15m): long when RSI < 30 and close < lower band, short mirrored,
//      take profit / stop loss 0.5%
//
//   node research/social.js
import { loadSpotHistoryCached } from './data.js';
import { ema, rsi, atr, supertrend, sma, stdev } from './lib.js';
import { tStat } from './stats.js';

const FROM = Date.parse('2021-01-01T00:00:00Z');
const SPLIT = Date.parse('2024-01-01T00:00:00Z');
const COST = 2 * (0.0005 + 0.0002); // round trip: taker fee + slippage, both sides
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

const aggregate = (s, minutes) => {
  const step = minutes * 60_000;
  const out = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < s.t.length; i++) {
    const b = Math.floor(s.t[i] / step) * step;
    const k = out.t.length - 1;
    if (k < 0 || out.t[k] !== b) {
      out.t.push(b);
      out.o.push(s.o[i]);
      out.h.push(s.h[i]);
      out.l.push(s.l[i]);
      out.c.push(s.c[i]);
    } else {
      out.h[k] = Math.max(out.h[k], s.h[i]);
      out.l[k] = Math.min(out.l[k], s.l[i]);
      out.c[k] = s.c[i];
    }
  }
  return out;
};

// generic bar-by-bar trader: signal(i) → +1/-1/0 at close i, entry at open i+1; exits by stop/target
// (checked on highs/lows, stop first) or by exitSignal(i, dir)
const trade = (b, signal, { stop, target, exitSignal }) => {
  const res = { A: [], B: [] };
  let pos = null;
  for (let i = 250; i < b.c.length - 1; i++) {
    if (pos) {
      let px = null;
      if (pos.sl && (pos.dir > 0 ? b.l[i] <= pos.sl : b.h[i] >= pos.sl)) px = pos.dir > 0 ? Math.min(b.o[i], pos.sl) : Math.max(b.o[i], pos.sl);
      else if (pos.tp && (pos.dir > 0 ? b.h[i] >= pos.tp : b.l[i] <= pos.tp)) px = pos.tp;
      else if (exitSignal && exitSignal(i, pos.dir)) px = b.c[i];
      if (px !== null) {
        const r = pos.dir * (px / pos.e - 1) - COST;
        (pos.t < SPLIT ? res.A : res.B).push(r);
        pos = null;
      }
    }
    if (!pos) {
      const s = signal(i);
      if (s) {
        const e = b.o[i + 1];
        const d = stop(i, e);
        pos = { dir: s, e, t: b.t[i + 1], sl: d ? e - s * d : null, tp: target ? e + s * target(i, e) : null };
      }
    }
  }
  return res;
};

const line = (rs) => {
  const m = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : NaN;
  const comp = (rs.reduce((a, r) => a * (1 + r), 1) - 1) * 100;
  return `${String(rs.length).padStart(5)} lệnh · thắng ${f((rs.filter((r) => r > 0).length / Math.max(1, rs.length)) * 100, 0)}% · TB ${f(m * 100, 2)}%/lệnh · t=${f(tStat(rs))} · cộng dồn (toàn vốn mỗi lệnh) ${f(comp, 0)}%`;
};

for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const raw = await loadSpotHistoryCached(sym, '5m', FROM);
  const h1 = aggregate(raw, 60);
  const m15 = aggregate(raw, 15);
  console.log(`\n=== ${sym} ===`);

  {
    const b = h1;
    const e200 = ema(b.c, 200);
    const r = rsi(b.c, 14);
    const a = atr(b, 14);
    const st = [[10, 1], [11, 2], [12, 3]].map(([p, m]) => supertrend(b, p, m));
    const greens = (i) => st.filter((d) => d[i] === 1).length;
    const res = trade(
      b,
      (i) => (b.c[i] > e200[i] && greens(i) >= 2 && r[i] < 40 ? 1 : b.c[i] < e200[i] && greens(i) <= 1 && r[i] > 60 ? -1 : 0),
      { stop: (i) => a[i], target: (i) => 1.5 * a[i] },
    );
    console.log(`1) Triple Supertrend + RSI + EMA200 (1h)\n   2021–2023: ${line(res.A)}\n   2024–nay : ${line(res.B)}`);
  }
  {
    const b = h1;
    const e20 = ema(b.c, 20);
    const e50 = ema(b.c, 50);
    const e200 = ema(b.c, 200);
    const res = trade(
      b,
      (i) => (e20[i - 1] <= e50[i - 1] && e20[i] > e50[i] && b.c[i] > e200[i] ? 1 : e20[i - 1] >= e50[i - 1] && e20[i] < e50[i] && b.c[i] < e200[i] ? -1 : 0),
      { stop: () => null, exitSignal: (i, dir) => (dir > 0 ? e20[i] < e50[i] : e20[i] > e50[i]) },
    );
    console.log(`2) EMA 20/50/200 crossover (1h)\n   2021–2023: ${line(res.A)}\n   2024–nay : ${line(res.B)}`);
  }
  {
    const b = m15;
    const r = rsi(b.c, 14);
    const mid = sma(b.c, 20);
    const sd = stdev(b.c, 20, mid);
    const res = trade(
      b,
      (i) => (r[i] < 30 && b.c[i] < mid[i] - 2 * sd[i] ? 1 : r[i] > 70 && b.c[i] > mid[i] + 2 * sd[i] ? -1 : 0),
      { stop: (i, e) => e * 0.005, target: (i, e) => e * 0.005 },
    );
    console.log(`3) RSI + Bollinger scalping (15m, TP/SL 0.5%)\n   2021–2023: ${line(res.A)}\n   2024–nay : ${line(res.B)}`);
  }
}
