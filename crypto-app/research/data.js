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
    nt: kept.map((r) => +r[8]), // number of trades
    tb: kept.map((r) => +r[9]), // taker-buy base volume
  };
};

// mulberry32 PRNG
export const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Geometric random walk. By default there is no edge (used to check the pipeline reports
// "no edge" on noise). `plant` injects a known edge to check the pipeline can find one:
//   ar   - return autocorrelation (momentum if >0, mean-reversion if <0)
//   flow - how strongly last bar's taker-buy ratio predicts the next return
export const syntheticSeries = (symbol, bars, seed, drift = 0, plant = {}) => {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const { ar = 0, flow = 0 } = plant;
  const s = { symbol, t: [], o: [], h: [], l: [], c: [], v: [], nt: [], tb: [] };
  let price = 100;
  let prevR = 0;
  let prevTbr = 0.5;
  for (let i = 0; i < bars; i++) {
    const o = price;
    const r = drift + ar * prevR + flow * (prevTbr - 0.5) + 0.008 * gauss();
    const c = o * Math.exp(r);
    const vol = 1000 * Math.exp(0.3 * gauss());
    const tbr = Math.min(0.9, Math.max(0.1, 0.5 + 0.08 * gauss()));
    s.t.push(Date.UTC(2022, 0, 1) + i * 4 * 3600_000);
    s.o.push(o);
    s.c.push(c);
    s.h.push(Math.max(o, c) * (1 + 0.003 * rand()));
    s.l.push(Math.min(o, c) * (1 - 0.003 * rand()));
    s.v.push(vol);
    s.tb.push(vol * tbr);
    s.nt.push(Math.round(vol / 2));
    price = c;
    prevR = r;
    prevTbr = tbr;
  }
  return s;
};
