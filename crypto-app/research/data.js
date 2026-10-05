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

const archiveFile = async (path, cacheable, base = ARCHIVE) => {
  const name = path.replace(/[/]/g, '_');
  const cached = new URL(name, CACHE_DIR);
  if (cacheable && existsSync(cached)) return readFileSync(cached, 'utf8');
  const res = await fetch(`${base}/${path}`);
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

// ---------- derivatives: funding rate, open interest, long/short ratios (futures archive) ----------
const pool = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const k = next++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
};

const monthsBetween = (fromMs, toMs) => {
  const out = [];
  const d = new Date(fromMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const end = new Date(toMs);
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
};

const csvRows = (csv) => (csv ? csv.split('\n').map((l) => l.trim().split(',')).filter((r) => /^\d/.test(r[0])) : []);

// [[calcTimeMs, rate, intervalHours], ...]
export const fetchFunding = async (symbol, fromMs) => {
  const current = new Date().toISOString().slice(0, 7);
  const months = monthsBetween(fromMs, Date.now()).filter((m) => m !== current);
  const csvs = await pool(months, 8, (ym) => archiveFile(`monthly/fundingRate/${symbol}/${symbol}-fundingRate-${ym}.zip`, true));
  return csvs.flatMap(csvRows).map((r) => [+r[0], +r[2], +r[1]]).sort((a, b) => a[0] - b[0]);
};

// [[timeMs, openInterest, oiValue, topAccLS, topPosLS, globalLS, takerLS], ...] — snapshots at minute 55
// of every hour (conservative: always known before the hourly candle closes).
export const fetchMetrics = async (symbol, fromMs, onProgress = () => {}) => {
  const now = new Date();
  const current = now.toISOString().slice(0, 7);
  const out = [];
  for (const ym of monthsBetween(fromMs, now.getTime())) {
    const cache = new URL(`metrics_${symbol}_${ym}.json`, CACHE_DIR);
    if (ym !== current && existsSync(cache)) {
      out.push(...JSON.parse(readFileSync(cache, 'utf8')));
      continue;
    }
    const [y, m] = ym.split('-').map(Number);
    const days = [];
    for (let d = 1; d <= 31; d++) {
      const day = new Date(Date.UTC(y, m - 1, d));
      if (day.getUTCMonth() !== m - 1 || day >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) break;
      days.push(day.toISOString().slice(0, 10));
    }
    const csvs = await pool(days, 32, (ymd) => archiveFile(`daily/metrics/${symbol}/${symbol}-metrics-${ymd}.zip`, false).catch(() => null));
    const rows = [];
    for (const csv of csvs) {
      if (!csv) continue;
      for (const line of csv.split('\n')) {
        const r = line.trim().split(',');
        if (r.length < 8 || !/^\d{4}-/.test(r[0]) || r[0].slice(14, 16) !== '55') continue;
        rows.push([Date.parse(r[0].replace(' ', 'T') + 'Z'), +r[2], +r[3], +r[4], +r[5], +r[6], +r[7]]);
      }
    }
    rows.sort((a, b) => a[0] - b[0]);
    if (ym !== current) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cache, JSON.stringify(rows));
    }
    out.push(...rows);
    onProgress(ym);
  }
  return out;
};

// Adds per-bar derivative series to s (aligned on candle close; never uses later data):
//   fund      sum of funding rates charged during the bar (futures P&L)
//   fundRate  latest known funding rate
//   oi, oiv, lsTopAcc, lsTopPos, lsAll, takerLS
export const attachDerivatives = (s, funding, metrics, barMs) => {
  const n = s.t.length;
  const nan = () => new Array(n).fill(NaN);
  s.fund = new Array(n).fill(0);
  s.fundRate = nan();
  let k = 0;
  let last = null;
  for (let i = 0; i < n; i++) {
    const open = s.t[i];
    const close = open + barMs - 1;
    while (k < funding.length && funding[k][0] < open) last = funding[k++];
    while (k < funding.length && funding[k][0] <= close) {
      s.fund[i] += funding[k][1];
      last = funding[k++];
    }
    // after the archive ends (current month) assume the last known rate keeps being charged
    if (k >= funding.length && last && open > last[0]) {
      const step = (last[2] || 8) * 3_600_000;
      const first = last[0] + Math.ceil((open - last[0]) / step) * step;
      for (let ft = first; ft <= close; ft += step) s.fund[i] += last[1];
    }
    if (last) s.fundRate[i] = last[1];
  }
  const keys = ['oi', 'oiv', 'lsTopAcc', 'lsTopPos', 'lsAll', 'takerLS'];
  keys.forEach((key) => (s[key] = nan()));
  let j = 0;
  for (let i = 0; i < n; i++) {
    const close = s.t[i] + barMs - 1;
    while (j + 1 < metrics.length && metrics[j + 1][0] <= close) j++;
    const row = metrics[j];
    if (!row || row[0] > close || close - row[0] > 86_400_000) continue;
    keys.forEach((key, q) => (s[key][i] = row[q + 1] || NaN));
  }
  return s;
};

// Download, align on common timestamps, drop coins without enough history, attach derivatives.
export const loadUniverse = async ({ market, symbols, interval, bars, derivs = true, log = console.log }) => {
  const raw = [];
  for (const sym of symbols) {
    try {
      raw.push(await fetchSeries(market, sym, interval, bars));
    } catch (e) {
      log(`  bỏ qua ${sym}: ${e.message.slice(0, 120)}`);
    }
  }
  const need = Math.floor(bars * 0.97) - 2;
  const short = raw.filter((s) => s.t.length < need).map((s) => s.symbol);
  if (short.length) log(`  bỏ ${short.length} coin chưa đủ lịch sử: ${short.join(', ')}`);
  let list = raw.filter((s) => s.t.length >= need);
  const common = list.reduce((acc, s) => {
    const set = new Set(s.t);
    return acc ? acc.filter((x) => set.has(x)) : s.t.slice();
  }, null) || [];
  const keep = new Set(common);
  list = list.map((s) => {
    const idx = s.t.map((x, i) => (keep.has(x) ? i : -1)).filter((i) => i >= 0);
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? idx.map((i) => v[i]) : v]));
  });
  if (derivs && list.length) {
    const barMs = intervalMs(interval);
    const from = list[0].t[0];
    let done = 0;
    for (const s of list) {
      try {
        const [f, m] = await Promise.all([fetchFunding(s.symbol, from), fetchMetrics(s.symbol, from)]);
        attachDerivatives(s, f, m, barMs);
      } catch (e) {
        log(`  ${s.symbol}: không lấy được dữ liệu phái sinh (${e.message.slice(0, 80)})`);
      }
      done++;
      if (done % 5 === 0 || done === list.length) log(`  dữ liệu phái sinh: ${done}/${list.length} coin`);
    }
  }
  return list;
};

// ---------- long spot history: monthly archives + REST mirror for the latest weeks ----------
const SPOT_ARCHIVE = 'https://data.binance.vision/data/spot';

// Columns as typed arrays { symbol, t, o, h, l, c } from fromMs (or the listing date) until now.
export const fetchSpotHistory = async (symbol, interval, fromMs) => {
  const current = new Date().toISOString().slice(0, 7);
  const months = monthsBetween(fromMs, Date.now()).filter((m) => m !== current);
  const csvs = await pool(months, 12, (ym) =>
    archiveFile(`monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`, false, SPOT_ARCHIVE).catch(() => null),
  );
  const rows = [];
  for (const r of csvs.flatMap(csvRows)) {
    let ts = +r[0];
    if (ts > 1e14) ts = Math.floor(ts / 1000); // archives switched to microseconds in 2025
    if (ts >= fromMs) rows.push([ts, +r[1], +r[2], +r[3], +r[4]]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  let start = rows.length ? rows[rows.length - 1][0] + 1 : fromMs;
  for (;;) {
    const res = await fetch(`${SPOT_MIRROR}?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${start}`);
    if (!res.ok) break;
    const page = await res.json();
    const closed = page.filter((k) => k[6] < Date.now());
    closed.forEach((k) => rows.push([k[0], +k[1], +k[2], +k[3], +k[4]]));
    if (page.length < 1000 || !closed.length) break;
    start = page[page.length - 1][0] + 1;
  }
  const col = (k) => Float64Array.from(rows, (r) => r[k]);
  return { symbol, t: col(0), o: col(1), h: col(2), l: col(3), c: col(4) };
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
//   trend - volatility of a slowly drifting expected return (multi-week momentum)
export const syntheticSeries = (symbol, bars, seed, drift = 0, plant = {}) => {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const { ar = 0, flow = 0, trend = 0 } = plant;
  let mu = 0;
  const s = { symbol, t: [], o: [], h: [], l: [], c: [], v: [], nt: [], tb: [], fund: [], fundRate: [], oi: [], oiv: [], lsTopAcc: [], lsTopPos: [], lsAll: [], takerLS: [] };
  let oi = 1e6;
  let rate = 0.0001;
  let price = 100;
  let prevR = 0;
  let prevTbr = 0.5;
  for (let i = 0; i < bars; i++) {
    const o = price;
    mu = 0.998 * mu + trend * gauss();
    const r = drift + mu + ar * prevR + flow * (prevTbr - 0.5) + 0.008 * gauss();
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
    rate = 0.9 * rate + 0.1 * 0.0001 + 0.00005 * gauss();
    oi *= Math.exp(0.01 * gauss());
    s.fundRate.push(rate);
    s.fund.push(i % 2 === 0 ? rate : 0);
    s.oi.push(oi);
    s.oiv.push(oi * c);
    s.lsTopAcc.push(Math.exp(0.2 * gauss()));
    s.lsTopPos.push(Math.exp(0.2 * gauss()));
    s.lsAll.push(Math.exp(0.2 * gauss()));
    s.takerLS.push(Math.exp(0.2 * gauss()));
    price = c;
    prevR = r;
    prevTbr = tbr;
  }
  return s;
};
