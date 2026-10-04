// Market data: Binance klines (spot / USDT-M futures) or a seeded synthetic series for offline tests.
// Where api.binance.com / fapi.binance.com answer HTTP 451 (restricted location), spot falls back
// to the public market-data mirror and futures to the official archive at data.binance.vision.
import { inflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ENDPOINTS = {
  spot: process.env.BINANCE_SPOT_URL || 'https://api.binance.com/api/v3/klines',
  futures: process.env.BINANCE_FUTURES_URL || 'https://fapi.binance.com/fapi/v1/klines',
};
const SPOT_MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const ARCHIVE = 'https://data.binance.vision/data/futures/um';
const CACHE_DIR = new URL('./.cache/', import.meta.url);
const PAGE = { spot: 1000, futures: 1500 };
const restricted = new Set(); // markets whose primary endpoint answered 451

const toSeries = (symbol, rows) => {
  const kept = rows.slice().filter((r) => +r[6] < Date.now()); // drop the still-open candle
  return {
    symbol,
    t: kept.map((r) => +r[0]),
    o: kept.map((r) => +r[1]),
    h: kept.map((r) => +r[2]),
    l: kept.map((r) => +r[3]),
    c: kept.map((r) => +r[4]),
    v: kept.map((r) => +r[5]),
    nt: kept.map((r) => +r[8]), // number of trades
    tb: kept.map((r) => +r[9]), // taker-buy base volume
  };
};

const fetchRest = async (base, symbol, interval, bars, limit) => {
  const rows = [];
  let endTime = Date.now();
  while (rows.length < bars) {
    const res = await fetch(`${base}?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`);
    if (!res.ok) {
      const err = new Error(`${symbol}: HTTP ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    const page = await res.json();
    if (!page.length) break;
    rows.unshift(...page);
    endTime = page[0][0] - 1;
  }
  return rows.slice(-bars);
};

// ---------- data.binance.vision archive (zip files with one CSV each) ----------
const unzipFirst = (buf) => {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
};

const archiveFile = async (path, cacheable) => {
  const name = path.replace(/[/]/g, '_');
  const cached = new URL(name, CACHE_DIR);
  if (cacheable && existsSync(cached)) return readFileSync(cached, 'utf8');
  const res = await fetch(`${ARCHIVE}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`archive ${path}: HTTP ${res.status}`);
  const csv = unzipFirst(Buffer.from(await res.arrayBuffer()));
  if (cacheable) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, csv);
  }
  return csv;
};

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const intervalMs = (iv) => +iv.slice(0, -1) * UNIT_MS[iv.slice(-1)];

const fetchFuturesArchive = async (symbol, interval, bars) => {
  const now = new Date();
  const months = Math.ceil((bars * intervalMs(interval)) / (28 * 86_400_000)) + 1;
  const paths = [];
  for (let k = months; k >= 1; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    const ym = d.toISOString().slice(0, 7);
    paths.push([`monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`, true]);
  }
  for (let day = 1; day < now.getUTCDate(); day++) {
    const ymd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day)).toISOString().slice(0, 10);
    paths.push([`daily/klines/${symbol}/${interval}/${symbol}-${interval}-${ymd}.zip`, true]);
  }
  const rows = new Map();
  for (let i = 0; i < paths.length; i += 8) {
    const csvs = await Promise.all(paths.slice(i, i + 8).map(([p, c]) => archiveFile(p, c)));
    for (const csv of csvs) {
      if (!csv) continue;
      for (const line of csv.split('\n')) {
        const r = line.trim().split(',');
        if (r.length < 10 || !/^\d+$/.test(r[0])) continue; // header / blank
        rows.set(+r[0], r);
      }
    }
  }
  const sorted = [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k));
  if (!sorted.length) throw new Error(`${symbol}: không có dữ liệu futures trong archive`);
  return sorted.slice(-bars);
};

export const fetchSeries = async (market, symbol, interval, bars) => {
  if (!restricted.has(market)) {
    try {
      return toSeries(symbol, await fetchRest(ENDPOINTS[market], symbol, interval, bars, PAGE[market]));
    } catch (e) {
      if (e.status !== 451) throw e;
      restricted.add(market);
      console.warn(`  ${market}: Binance chặn vị trí máy chủ (HTTP 451) → dùng ${market === 'spot' ? 'data-api.binance.vision' : 'archive data.binance.vision'}`);
    }
  }
  if (market === 'spot') return toSeries(symbol, await fetchRest(SPOT_MIRROR, symbol, interval, bars, 1000));
  return toSeries(symbol, await fetchFuturesArchive(symbol, interval, bars));
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
