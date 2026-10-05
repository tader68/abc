#!/usr/bin/env node
// Export a long, wide panel for the ML study: ~100 USDT-M perpetuals (including delisted ones)
// on 4h candles since 2021, each coin's features computed on its own trading history and placed
// on a common timeline (unknown = 255 before listing / after delisting).
// Funding since 2021; open-interest / long-short metrics only where already cached (2023+).
//
//   node research/mlexport2.js [--from 2021-01] [--interval 4h]
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchFuturesHistory, fetchFunding, fetchMetrics, attachDerivatives } from './data.js';
import { buildFeatureSeries, rollingRank } from './features.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';

const args = parseArgs(process.argv.slice(2));
const FROM = Date.parse(`${args.from || '2021-01'}-01T00:00:00Z`);
const IV = args.interval || '4h';
const BAR = { '1h': 3_600_000, '4h': 14_400_000 }[IV];
const EXTRA = [
  '1000PEPEUSDT', '1000SHIBUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'WIFUSDT', 'ARBUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT', 'JUPUSDT',
  'WLDUSDT', 'PYTHUSDT', 'ENAUSDT', 'ORDIUSDT', 'STXUSDT', 'RUNEUSDT', 'IMXUSDT', 'LDOUSDT', 'FETUSDT', 'GALAUSDT', 'CFXUSDT',
  'TONUSDT', 'JASMYUSDT', 'ONDOUSDT', 'TAOUSDT', 'PENDLEUSDT', 'BLURUSDT', 'PEOPLEUSDT', 'GMTUSDT', 'APEUSDT', 'DYDXUSDT',
  'MASKUSDT', 'KAVAUSDT', 'EGLDUSDT', 'KSMUSDT', 'ZILUSDT', '1INCHUSDT', 'LRCUSDT', 'SUSHIUSDT', 'YFIUSDT', 'ENSUSDT', 'GMXUSDT',
  'WOOUSDT', 'CELOUSDT',
];
const DEAD = ['LUNAUSDT', 'FTTUSDT', 'SRMUSDT', 'MATICUSDT', 'FTMUSDT', 'EOSUSDT', 'MKRUSDT', 'OCEANUSDT', 'AGIXUSDT', 'WAVESUSDT', 'OMGUSDT', 'KLAYUSDT', 'BALUSDT', 'SXPUSDT', 'RNDRUSDT'];
const SYMBOLS = [...DEFAULT_UNIVERSE, ...EXTRA, ...DEAD];
const dir = new URL(`./.cache/ml/panel_${IV}/`, import.meta.url);
mkdirSync(dir, { recursive: true });

const btcRaw = await fetchFuturesHistory('BTCUSDT', IV, FROM);
const T = [...btcRaw.t];
const idxOf = new Map(T.map((t, i) => [t, i]));
const n = T.length;
const btcClose = new Map(T.map((t, i) => [t, btcRaw.c[i]]));
console.log(`Trục thời gian: ${n} nến ${IV} (${new Date(T[0]).toISOString().slice(0, 10)} → ${new Date(T[n - 1]).toISOString().slice(0, 10)})`);

let names = null;
const kept = [];
for (const sym of SYMBOLS) {
  let s;
  try {
    s = await fetchFuturesHistory(sym, IV, FROM);
  } catch (e) {
    console.log(`  bỏ ${sym}: ${e.message.slice(0, 60)}`);
    continue;
  }
  if (s.t.length < 600) {
    console.log(`  bỏ ${sym}: chỉ ${s.t.length} nến`);
    continue;
  }
  const series = { symbol: sym, t: [...s.t], o: [...s.o], h: [...s.h], l: [...s.l], c: [...s.c], v: [...s.v], nt: [...s.nt], tb: [...s.tb] };
  const [funding, metrics] = await Promise.all([fetchFunding(sym, FROM), fetchMetrics(sym, Date.UTC(2023, 1, 1), () => {}, { cacheOnly: true })]);
  attachDerivatives(series, funding, metrics, BAR);
  const btc = { c: series.t.map((t) => btcClose.get(t) ?? NaN) };
  const F = buildFeatureSeries(series, { btc });
  if (!names) names = F.map((x) => x.id);
  const byId = new Map(F.map((x) => [x.id, x.series]));
  const X = new Uint8Array(n * names.length).fill(255);
  const P = new Float64Array(n * 5).fill(NaN);
  names.forEach((id, f) => {
    const x = byId.get(id);
    if (!x) return;
    const r = rollingRank(x);
    for (let k = 0; k < series.t.length; k++) {
      const i = idxOf.get(series.t[k]);
      if (i !== undefined) X[i * names.length + f] = r[k];
    }
  });
  for (let k = 0; k < series.t.length; k++) {
    const i = idxOf.get(series.t[k]);
    if (i === undefined) continue;
    P[i * 5] = series.o[k];
    P[i * 5 + 1] = series.h[k];
    P[i * 5 + 2] = series.l[k];
    P[i * 5 + 3] = series.c[k];
    P[i * 5 + 4] = Number.isFinite(series.fund[k]) ? series.fund[k] : 0;
  }
  writeFileSync(new URL(`X_${sym}.bin`, dir), X);
  writeFileSync(new URL(`P_${sym}.bin`, dir), Buffer.from(P.buffer));
  kept.push(sym);
  console.log(`  ${String(kept.length).padStart(3)}. ${sym.padEnd(14)} ${series.t.length} nến từ ${new Date(series.t[0]).toISOString().slice(0, 10)} đến ${new Date(series.t[series.t.length - 1]).toISOString().slice(0, 10)}`);
}
writeFileSync(new URL('meta.json', dir), JSON.stringify({ market: 'futures', interval: IV, n, features: names, symbols: kept, t: T }));
console.log(`Đã xuất ${kept.length} coin × ${names.length} chỉ báo → ${dir.pathname}`);
