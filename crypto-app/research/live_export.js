#!/usr/bin/env node
// Live data for the signal bot: the last ~1500 closed 4h candles of every coin the models know,
// with funding, turned into the same features as the training panel (mlexport2.js) and written in
// the same format to research/.cache/live/panel/.
//
// Uses fapi.binance.com (works from Vietnam). Where Binance blocks the location (HTTP 451) it falls
// back to the public archive, which lags by up to a day: fine for testing, not for trading.
//
//   node research/live_export.js [--bars 1500] [--max-stale-hours 12]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchSeries, fetchFunding, attachDerivatives, pool } from './data.js';
import { buildFeatureSeries, rollingRank } from './features.js';
import { parseArgs } from './common.js';

const args = parseArgs(process.argv.slice(2));
const BARS = +args.bars || 1500;
const BAR = 14_400_000;
const MAX_STALE = (+args['max-stale-hours'] || 12) * 3_600_000; // a coin whose last candle is older is treated as delisted
const meta = JSON.parse(readFileSync(new URL('./live/models/meta.json', import.meta.url), 'utf8'));
const dir = new URL('./.cache/live/panel/', import.meta.url);
mkdirSync(dir, { recursive: true });

const liveFunding = async (sym, fromMs) => {
  // newest funding first from the live API; the archive (complete months only) is the fallback
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${fromMs}&limit=1000`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()).map((r) => [+r.fundingTime, +r.fundingRate, 8]);
    if (rows.length) return rows;
  } catch {
    // fall through to the archive
  }
  return fetchFunding(sym, fromMs);
};

const load = async (sym) => {
  try {
    const s = await fetchSeries('futures', sym, '4h', BARS);
    const live = [...s.t.keys()].filter((k) => s.v[k] > 0 && s.h[k] > s.l[k]); // same filter as the training panel
    const pick = (a) => live.map((k) => a[k]);
    const series = { symbol: sym, t: pick(s.t), o: pick(s.o), h: pick(s.h), l: pick(s.l), c: pick(s.c), v: pick(s.v), nt: pick(s.nt), tb: pick(s.tb) };
    if (series.t.length < 400) return null;
    if (Date.now() - series.t[series.t.length - 1] - BAR > MAX_STALE) return null; // no longer trading
    attachDerivatives(series, await liveFunding(sym, series.t[0]), [], BAR);
    return series;
  } catch (e) {
    console.log(`  bỏ ${sym}: ${String(e.message).slice(0, 80)}`);
    return null;
  }
};

// contracts Binance has scheduled for delisting: a perpetual normally has deliveryDate in 2100; once a delisting is
// announced it is set to the settlement time. Their price usually collapses first, which looks like a 'dip' to the
// models, so the bot must not buy them (and must warn about open positions in them).
let delisting = [];
let delistingKnown = false;
try {
  const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = await res.json();
  const far = Date.UTC(2090, 0, 1);
  delisting = info.symbols
    .filter((x) => meta.symbols.includes(x.symbol) && (x.status !== 'TRADING' || (x.contractType === 'PERPETUAL' && x.deliveryDate < far)))
    .map((x) => x.symbol);
  delistingKnown = true;
  if (delisting.length) console.log(`  Binance sắp gỡ / ngừng giao dịch: ${delisting.join(', ')}`);
} catch (e) {
  console.log(`  ⚠️ không đọc được danh sách coin sắp bị gỡ (${String(e.message).slice(0, 60)})`);
}

const all = (await pool(meta.symbols, 6, load)).filter(Boolean);
const btcS = all.find((s) => s.symbol === 'BTCUSDT');
if (!btcS) throw new Error('không tải được BTCUSDT');
const T = btcS.t;
const n = T.length;
const idxOf = new Map(T.map((t, i) => [t, i]));
const btcClose = new Map(T.map((t, i) => [t, btcS.c[i]]));
const names = meta.panel_features;
const kept = [];
for (const series of all) {
  const btc = { c: series.t.map((t) => btcClose.get(t) ?? NaN) };
  const byId = new Map(buildFeatureSeries(series, { btc }).map((x) => [x.id, x.series]));
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
  writeFileSync(new URL(`X_${series.symbol}.bin`, dir), X);
  writeFileSync(new URL(`P_${series.symbol}.bin`, dir), Buffer.from(P.buffer));
  kept.push(series.symbol);
}
writeFileSync(new URL('meta.json', dir), JSON.stringify({ market: 'futures', interval: '4h', n, features: names, symbols: kept, t: T, updated: Date.now(), delisting, delistingKnown }));
const lastClose = T[n - 1] + BAR;
const ageH = (Date.now() - lastClose) / 3_600_000;
console.log(`Dữ liệu live: ${kept.length} coin × ${n} nến 4h, nến đóng gần nhất ${new Date(lastClose + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} giờ VN (cách đây ${ageH.toFixed(1)} giờ)`);
if (ageH > 6) console.log('⚠️ Dữ liệu KHÔNG phải mới nhất (Binance futures API không trả lời?). Bot sẽ không gửi tín hiệu.');
