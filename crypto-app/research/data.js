// Market data: Binance klines (spot / USDT-M futures) or a seeded synthetic series for offline tests.
const ENDPOINTS = {
  spot: process.env.BINANCE_SPOT_URL || 'https://api.binance.com/api/v3/klines',
  futures: process.env.BINANCE_FUTURES_URL || 'https://fapi.binance.com/fapi/v1/klines',
};
const PAGE = { spot: 1000, futures: 1500 };

export const fetchSeries = async (market, symbol, interval, bars) => {
  const rows = [];
  let endTime = Date.now();
  while (rows.length < bars) {
    const url = `${ENDPOINTS[market]}?symbol=${symbol}&interval=${interval}&limit=${PAGE[market]}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${market} ${symbol}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    if (!page.length) break;
    rows.unshift(...page);
    endTime = page[0][0] - 1;
  }
  const kept = rows.slice(-bars).filter((r) => r[6] < Date.now()); // drop the still-open candle
  return {
    symbol,
    t: kept.map((r) => r[0]),
    o: kept.map((r) => +r[1]),
    h: kept.map((r) => +r[2]),
    l: kept.map((r) => +r[3]),
    c: kept.map((r) => +r[4]),
    v: kept.map((r) => +r[5]),
  };
};

// mulberry32 PRNG
const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Geometric random walk, no edge by construction (used to sanity-check that the
// pipeline reports "no edge" on noise, and to run tests without network access).
export const syntheticSeries = (symbol, bars, seed, drift = 0) => {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const s = { symbol, t: [], o: [], h: [], l: [], c: [], v: [] };
  let price = 100;
  for (let i = 0; i < bars; i++) {
    const o = price;
    const c = o * Math.exp(drift + 0.008 * gauss());
    s.t.push(Date.UTC(2024, 0, 1) + i * 3600_000);
    s.o.push(o);
    s.c.push(c);
    s.h.push(Math.max(o, c) * (1 + 0.003 * rand()));
    s.l.push(Math.min(o, c) * (1 - 0.003 * rand()));
    s.v.push(1000);
    price = c;
  }
  return s;
};
