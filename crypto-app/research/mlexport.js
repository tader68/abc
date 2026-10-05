#!/usr/bin/env node
// Export the indicator library (causal rolling-rank features) for the ML study (ml_model.py).
// Writes research/.cache/ml/<market>_<interval>/: meta.json + per-coin binaries.
//
//   node research/mlexport.js [--market futures] [--interval 4h] [--bars 8000] [--symbols ...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { featureMatrix } from './features.js';
import { parseArgs, DEFAULT_UNIVERSE, loadMarket } from './common.js';

const args = parseArgs(process.argv.slice(2));
const opt = {
  market: args.market || 'futures',
  interval: args.interval || '4h',
  bars: +args.bars || 8000,
  symbols: args.symbols ? args.symbols.split(',') : DEFAULT_UNIVERSE,
  synthetic: !!args.synthetic,
  seed: 1,
};
const dir = new URL(`./.cache/ml/${opt.market}_${opt.interval}/`, import.meta.url);
mkdirSync(dir, { recursive: true });

const series = await loadMarket(opt, opt.market, console.log);
const btc = series.find((s) => s.symbol === 'BTCUSDT') || null;
console.log(`Tính ${series.length} coin × ${series[0].c.length} nến...`);
const { names, ranks } = featureMatrix(series, btc);
const n = series[0].c.length;
series.forEach((s, si) => {
  // features: Uint8 ranks, row-major [bar][feature]; 255 = unknown
  const X = new Uint8Array(n * names.length);
  for (let f = 0; f < names.length; f++) {
    const r = ranks[si][f];
    for (let i = 0; i < n; i++) X[i * names.length + f] = r[i];
  }
  writeFileSync(new URL(`X_${s.symbol}.bin`, dir), X);
  // prices / funding for targets and P&L: float64 [open, high, low, close, fund] per bar
  const P = new Float64Array(n * 5);
  for (let i = 0; i < n; i++) {
    P[i * 5] = s.o[i];
    P[i * 5 + 1] = s.h[i];
    P[i * 5 + 2] = s.l[i];
    P[i * 5 + 3] = s.c[i];
    P[i * 5 + 4] = Array.isArray(s.fund) && Number.isFinite(s.fund[i]) ? s.fund[i] : 0;
  }
  writeFileSync(new URL(`P_${s.symbol}.bin`, dir), Buffer.from(P.buffer));
});
writeFileSync(new URL('meta.json', dir), JSON.stringify({ market: opt.market, interval: opt.interval, n, features: names, symbols: series.map((s) => s.symbol), t: series[0].t }));
console.log(`Đã xuất ${names.length} chỉ báo → ${dir.pathname}`);
