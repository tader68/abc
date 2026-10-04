#!/usr/bin/env node
// Cross-sectional rotation: every R days rank all coins by an indicator, hold the top K
// (spot: long only; futures: long only, or long top K + short bottom K). Searches every
// indicator in the library (and pairs of the best ones) with the same train -> validation ->
// hold-out funnel as discover.js.
//
//   node research/rotation.js [--market spot|futures|both] [--interval 4h] [--bars 8000]
//        [--symbols ...] [--finalists 10] [--out rotation-results.json] [--synthetic] [--no-derivs]
import { writeFileSync } from 'node:fs';
import { MARKETS, WARMUP, ema } from './lib.js';
import { buildFeatureSeries } from './features.js';
import { periodStats, tStat } from './stats.js';
import { parseArgs, DEFAULT_UNIVERSE, loadMarket } from './common.js';

const args = parseArgs(process.argv.slice(2));
const opt = {
  market: args.market || 'both',
  interval: args.interval || '4h',
  bars: +args.bars || 8000,
  symbols: args.symbols ? args.symbols.split(',') : DEFAULT_UNIVERSE,
  finalists: +args.finalists || 10,
  seed: +args.seed || 1,
  out: args.out || 'rotation-results.json',
  synthetic: !!args.synthetic,
  plant: { ar: +args['plant-ar'] || 0, flow: +args['plant-flow'] || 0, trend: +args['plant-trend'] || 0 },
  noDerivs: !!args['no-derivs'],
};
const T_MIN = 2.5; // t-stat of weekly returns required on the hold-out
const KS = [3, 5, 8];
const RS = [1, 3, 7]; // rebalance every R days
const START = Math.max(WARMUP, 300);
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
const day = (t) => new Date(t).toISOString().slice(0, 10);

// ---------- portfolio simulation ----------
// ctx: { n, coins, ret[si][i], fund[si][i] | null, decisions: [{i, d}], order(f, d) -> coin idx sorted desc,
//        cost, btcOk[i] (BTC above EMA100) }
const simulate = (ctx, cand, from, to, wantCurve = false) => {
  const { coins, ret, fund, decisions, cost } = ctx;
  let w = new Float64Array(coins);
  let held = [];
  let eq = 1;
  let peak = 1;
  let maxDD = 0;
  let turnover = 0;
  const curve = wantCurve ? new Float64Array(to - from) : null;
  let di = 0;
  while (di < decisions.length && decisions[di].i < from - 1) di++;
  let counter = 0;
  for (let i = from; i < to; i++) {
    // weights decided at the close of bar i-1 apply to bar i
    if (di < decisions.length && decisions[di].i === i - 1) {
      if (counter % cand.R === 0) {
        const order = cand.orderFn(decisions[di].d);
        const next = new Float64Array(coins);
        const longBook = cand.filter && !ctx.btcOk[i - 1] ? 0 : 1;
        if (order.length >= (cand.mode === 'ls' ? 2 * cand.K : cand.K)) {
          for (let k = 0; k < cand.K; k++) next[order[k]] = longBook / cand.K;
          if (cand.mode === 'ls') for (let k = 0; k < cand.K; k++) next[order[order.length - 1 - k]] = -1 / cand.K;
        }
        let tv = 0;
        for (let c = 0; c < coins; c++) tv += Math.abs(next[c] - w[c]);
        eq *= 1 - tv * cost;
        turnover += tv;
        w = next;
        held = [];
        for (let c = 0; c < coins; c++) if (w[c] !== 0) held.push(c);
      }
      counter++;
      di++;
    }
    let r = 0;
    for (const c of held) {
      r += w[c] * ret[c][i];
      if (fund) r -= w[c] * fund[c][i];
    }
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    if (curve) curve[i - from] = eq;
  }
  const retPct = (eq - 1) * 100;
  return { ret: retPct, maxDD: maxDD * 100, score: retPct - 1.5 * maxDD * 100, turnover, curve, weights: w };
};

const describe = (c, names) =>
  `${c.label || `${c.dir > 0 ? 'cao nhất' : 'thấp nhất'} theo ${names[c.f]}`} · giữ ${c.K} coin${c.mode === 'ls' ? ` + short ${c.K} coin ngược lại` : ''} · rebalance ${c.R} ngày${c.filter ? ' · chỉ Long khi BTC > EMA100' : ''}`;

const analyse = async (market) => {
  const t0 = Date.now();
  const m = MARKETS[market];
  log(`\n${'='.repeat(70)}\nXOAY VÒNG COIN — ${market.toUpperCase()} (${m.allowShort ? 'long-only hoặc long/short' : 'chỉ Long'})\n${'='.repeat(70)}`);
  const series = await loadMarket(opt, market, log);
  if (series.length < 10) throw new Error('Cần ít nhất 10 coin cho chiến lược xoay vòng');
  const n = series[0].c.length;
  const coins = series.length;
  const t = series[0].t;
  const barMs = t[1] - t[0];
  const btc = series.find((s) => s.symbol === 'BTCUSDT') || series[0];

  const hs = Math.floor(n * 0.75);
  const tv = START + Math.floor(((hs - START) * 2) / 3);
  log(`${coins} coin × ${n} nến ${opt.interval}: train ${day(t[START])}→${day(t[tv - 1])} · validation →${day(t[hs - 1])} · HOLD-OUT ${day(t[hs])}→${day(t[n - 1])}`);

  // decision points: daily closes
  const decisions = [];
  for (let i = START; i < n; i++) if ((t[i] + barMs) % 86_400_000 === 0) decisions.push({ i, d: decisions.length });

  // features sampled at decision points: val[f][d * coins + c]
  log('Dựng thư viện chỉ báo cho từng coin...');
  let names = null;
  let val = null;
  series.forEach((s, c) => {
    const F = buildFeatureSeries(s, { btc });
    if (!names) {
      names = F.map((x) => x.id);
      val = names.map(() => new Float32Array(decisions.length * coins).fill(NaN));
    }
    const byId = new Map(F.map((x) => [x.id, x.series]));
    names.forEach((id, k) => {
      const x = byId.get(id);
      if (!x) return;
      decisions.forEach(({ i, d }) => (val[k][d * coins + c] = x[i]));
    });
  });
  log(`  ${names.length} chỉ báo × ${decisions.length} ngày`);

  // cached cross-sectional order (descending) per feature and day
  const orderCache = names.map(() => new Array(decisions.length));
  const orderOf = (k, d) => {
    let o = orderCache[k][d];
    if (!o) {
      const idx = [];
      for (let c = 0; c < coins; c++) if (Number.isFinite(val[k][d * coins + c])) idx.push(c);
      idx.sort((a, b) => val[k][d * coins + b] - val[k][d * coins + a]);
      o = orderCache[k][d] = Int16Array.from(idx);
    }
    return o;
  };
  const reversed = new Map();
  const orderFnFor = (k, dir) => {
    if (dir > 0) return (d) => orderOf(k, d);
    return (d) => {
      const key = k * 100000 + d;
      if (!reversed.has(key)) reversed.set(key, orderOf(k, d).slice().reverse());
      return reversed.get(key);
    };
  };

  const ret = series.map((s) => {
    const r = new Float64Array(n);
    for (let i = 1; i < n; i++) r[i] = s.c[i] / s.c[i - 1] - 1;
    return r;
  });
  const fund = m.allowShort && series.every((s) => Array.isArray(s.fund)) ? series.map((s) => Float64Array.from(s.fund, (x) => (Number.isFinite(x) ? x : 0))) : null;
  const e100 = ema(btc.c, 100);
  const btcOk = btc.c.map((x, i) => x > e100[i]);
  const ctx = { n, coins, ret, fund, decisions, cost: m.fee + m.slippage, btcOk };

  // 1. single-indicator grid on train
  const modes = m.allowShort ? ['long', 'ls'] : ['long'];
  const cands = [];
  for (let k = 0; k < names.length; k++)
    for (const dir of [1, -1])
      for (const K of KS)
        for (const R of RS)
          for (const mode of modes)
            for (const filter of mode === 'long' ? [0, 1] : [0]) {
              const cand = { f: k, dir, K, R, mode, filter, orderFn: orderFnFor(k, dir) };
              cand.train = simulate(ctx, cand, START, tv);
              cands.push(cand);
            }
  log(`Đã thử ${cands.length} cấu hình xoay vòng 1 chỉ báo trên train`);

  // 2. pairs of the best distinct indicators (average of the two cross-sectional ranks)
  const bestByFeature = new Map();
  for (const c of cands) if (!bestByFeature.has(c.f) || c.train.score > bestByFeature.get(c.f).train.score) bestByFeature.set(c.f, c);
  const tops = [...bestByFeature.values()].sort((a, b) => b.train.score - a.train.score).slice(0, 20);
  let pairs = 0;
  for (let a = 0; a < tops.length; a++)
    for (let b = a + 1; b < tops.length; b++) {
      const A = tops[a];
      const B = tops[b];
      const cache = new Map();
      const orderFn = (d) => {
        if (cache.has(d)) return cache.get(d);
        const oa = A.orderFn(d);
        const ob = B.orderFn(d);
        const score = new Map();
        oa.forEach((c, r) => score.set(c, r / oa.length));
        const both = [];
        ob.forEach((c, r) => score.has(c) && both.push([c, score.get(c) + r / ob.length]));
        const o = both.sort((x, y) => x[1] - y[1]).map((x) => x[0]);
        cache.set(d, o);
        return o;
      };
      const cand = { ...A, orderFn, label: `kết hợp [${A.dir > 0 ? '+' : '−'}${names[A.f]}] + [${B.dir > 0 ? '+' : '−'}${names[B.f]}]` };
      cand.train = simulate(ctx, cand, START, tv);
      cands.push(cand);
      pairs++;
    }
  log(`+ ${pairs} cấu hình kết hợp 2 chỉ báo tốt nhất`);

  // 3. funnel
  const pool = cands.filter((c) => c.train.score > 0).sort((a, b) => b.train.score - a.train.score).slice(0, 300);
  const validated = [];
  for (const c of pool) {
    const v = simulate(ctx, c, tv, hs);
    if (v.ret > 0 && v.score > 0) validated.push({ ...c, val: v, rank: Math.min(c.train.score, v.score) });
  }
  validated.sort((a, b) => b.rank - a.rank);
  // keep one config per indicator set so finalists are not near-duplicates
  const finalists = [];
  const seenLabel = new Set();
  for (const c of validated) {
    const key = c.label || names[c.f];
    if (seenLabel.has(key)) continue;
    seenLabel.add(key);
    finalists.push(c);
    if (finalists.length >= opt.finalists) break;
  }
  log(`Phễu: ${cands.length} cấu hình → ${pool.length} tốt nhất train → ${validated.length} qua validation → ${finalists.length} vào hold-out`);

  // equal-weight benchmark on the hold-out
  let bh = 1;
  for (let i = hs; i < n; i++) bh *= 1 + ret.reduce((a, r) => a + r[i], 0) / coins;
  const rows = finalists.map((c) => {
    const h = simulate(ctx, c, hs, n, true);
    const ps = periodStats(t.slice(hs, n), Array.from(h.curve));
    const tstat = tStat(ps.weeks.map((w) => w.ret));
    return { c, h, ps, tstat, pass: h.ret > 0 && tstat >= T_MIN };
  });
  if (rows.length) {
    log(`\nHOLD-OUT ${day(t[hs])} → ${day(t[n - 1])}  (giữ đều tất cả coin: ${f((bh - 1) * 100)}%)`);
    log('#  Train   Valid  | Hold-out  MaxDD   t-stat(tuần) | Tuần lãi  Tháng lãi  Tháng tệ nhất | Kết luận');
    rows.forEach((r, i) =>
      log(
        `${String(i + 1).padEnd(3)}${f(r.c.train.score).padEnd(7)} ${f(r.c.val.score).padEnd(6)} | ${(f(r.h.ret) + '%').padEnd(9)} ${(f(r.h.maxDD) + '%').padEnd(7)} ${f(r.tstat).padEnd(12)} | ` +
          `${(f(r.ps.weekly.positivePct, 0) + '%').padEnd(9)} ${(f(r.ps.monthly.positivePct, 0) + '%').padEnd(10)} ${(f(r.ps.monthly.worst) + '%').padEnd(13)} | ${r.pass ? '✔ ĐẠT' : '✘ không đạt'}`,
      ),
    );
    log('\nChi tiết:');
    rows.forEach((r, i) => log(`  #${i + 1} ${describe(r.c, names)}`));
  }
  const passed = rows.filter((r) => r.pass);
  log(passed.length ? `\n✔ ${passed.length} cấu hình đạt chuẩn trên hold-out (lãi, t-stat tuần ≥ ${T_MIN}).` : '\n✘ Không cấu hình xoay vòng nào đạt chuẩn trên hold-out.');

  const holdings = passed.slice(0, 3).map((r) => {
    // portfolio decided at the latest daily close
    const last = decisions[decisions.length - 1];
    const order = r.c.orderFn(last.d);
    const longBook = r.c.filter && !btcOk[last.i] ? 0 : 1;
    const list = [];
    for (let k = 0; k < r.c.K && longBook; k++) list.push({ symbol: series[order[k]].symbol, weight: 1 / r.c.K });
    if (r.c.mode === 'ls') for (let k = 0; k < r.c.K; k++) list.push({ symbol: series[order[order.length - 1 - k]].symbol, weight: -1 / r.c.K });
    log(`\nDanh mục tại ${day(t[last.i] + barMs)} — ${describe(r.c, names)}:${list.length ? '' : ' đứng ngoài (tiền mặt)'}`);
    list.sort((a, b) => b.weight - a.weight).forEach((x) => log(`  ${x.weight > 0 ? 'LONG ' : 'SHORT'} ${x.symbol.padEnd(10)} ${f(Math.abs(x.weight) * 100, 0)}% vốn`));
    return { strategy: describe(r.c, names), list };
  });
  log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return {
    market,
    coins: series.map((s) => s.symbol),
    funnel: { tried: cands.length, passedValidation: validated.length, finalists: rows.length, passedHoldout: passed.length },
    benchmarkHoldout: (bh - 1) * 100,
    finalists: rows.map((r) => ({ desc: describe(r.c, names), train: r.c.train.score, validation: r.c.val.score, holdout: { ret: r.h.ret, maxDD: r.h.maxDD, tstat: r.tstat }, weekly: r.ps.weekly, monthly: r.ps.monthly, monthlyReturns: r.ps.months, pass: r.pass })),
    holdings,
  };
};

const markets = opt.market === 'both' ? ['spot', 'futures'] : [opt.market];
const results = [];
for (const mk of markets) results.push(await analyse(mk));
writeFileSync(opt.out, JSON.stringify({ generatedAt: new Date().toISOString(), options: opt, results }, null, 2));
log(`\nĐã lưu: ${opt.out}`);
