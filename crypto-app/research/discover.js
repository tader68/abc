#!/usr/bin/env node
// Strategy discovery on Binance spot / futures:
//   1. ~240-indicator library (price, volume, order flow, funding / open interest / long-short) + formulas evolved by genetic programming (new indicators)
//   2. evolutionary search over rules combining indicators, plus classic strategy grids
//   3. funnel: train -> validation -> ONE look at an untouched hold-out period
//
//   node research/discover.js [--market spot|futures|both] [--interval 4h] [--bars 8000]
//        [--symbols BTCUSDT,ETHUSDT,...] [--islands 3] [--pop 240] [--gens 14] [--finalists 10]
//        [--seed 1] [--out file.json] [--force-signals] [--no-derivs] [--synthetic [--plant-ar 0.08] [--plant-flow 0.3]]
import { writeFileSync } from 'node:fs';
import { STRATEGIES, EXIT_GRID, MARKETS, WARMUP, atr, buyAndHold } from './lib.js';
import { rng } from './data.js';
import { featureMatrix, rollingRank } from './features.js';
import { parseArgs, DEFAULT_UNIVERSE, loadMarket } from './common.js';
import { makeGpContext, evolveIndicators, indicatorSeries } from './gp.js';
import { evalSigs, evolveRules, ruleSignals, describeRule } from './search.js';
import { portfolioEquity, periodStats, tStat } from './stats.js';

const args = parseArgs(process.argv.slice(2));
const opt = {
  market: args.market || 'both',
  interval: args.interval || '4h',
  bars: +args.bars || 8000,
  symbols: args.symbols ? args.symbols.split(',') : DEFAULT_UNIVERSE,
  noDerivs: !!args['no-derivs'],
  islands: +args.islands || 3,
  pop: +args.pop || 240,
  gens: +args.gens || 14,
  finalists: +args.finalists || 10,
  seed: +args.seed || 1,
  out: args.out || 'discover-results.json',
  synthetic: !!args.synthetic,
  plant: { ar: +args['plant-ar'] || 0, flow: +args['plant-flow'] || 0, trend: +args['plant-trend'] || 0 },
  forceSignals: !!args['force-signals'],
};
const T_MIN = 2.5; // per-trade t-statistic needed on the hold-out (10 finalists tested -> stricter than 1.96)
const E0 = { slMult: 3, tpMult: 0, trail: true }; // generic exit used while evolving rules
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
const day = (t) => new Date(t).toISOString().slice(0, 10);

const analyse = async (market) => {
  const t0 = Date.now();
  log(`\n${'='.repeat(70)}\n${market.toUpperCase()}  (phí ${MARKETS[market].fee * 100}%/chiều, ${MARKETS[market].allowShort ? 'Long+Short' : 'chỉ Long'}, đòn bẩy tối đa ${MARKETS[market].maxLeverage}x)\n${'='.repeat(70)}`);
  const series = await loadMarket(opt, market, log);
  if (series.length < 3) throw new Error('Cần dữ liệu ít nhất 3 coin');
  const n = series[0].c.length;
  const names0 = series.map((s) => s.symbol);
  const btc = series.find((s) => s.symbol === 'BTCUSDT') || null;
  const atrs = series.map((s) => atr(s, 14));
  const ctx = { series, atrs, market };

  // time split: train | validation | hold-out (never used during search)
  const hs = Math.floor(n * 0.75);
  const tv = WARMUP + Math.floor(((hs - WARMUP) * 2) / 3);
  const t = series[0].t;
  log(`${series.length} coin × ${n} nến ${opt.interval}:`);
  log(`  train      ${day(t[WARMUP])} → ${day(t[tv - 1])}  (${tv - WARMUP} nến)`);
  log(`  validation ${day(t[tv])} → ${day(t[hs - 1])}  (${hs - tv} nến)`);
  log(`  HOLD-OUT   ${day(t[hs])} → ${day(t[n - 1])}  (${n - hs} nến) — chỉ xem 1 lần ở cuối`);
  const minTrain = Math.max(10, Math.round((tv - WARMUP) / 250));
  const minVal = Math.max(4, Math.round((hs - tv) / 400));

  // 1. indicator library
  log('\n[1/4] Dựng thư viện chỉ báo...');
  const { names: featureNames, ranks: ranksBySymbol } = featureMatrix(series, btc);
  const nDeriv = featureNames.filter((x) => /^(fund|oi|ls|taker|smart)/.test(x)).length;
  log(`  ${featureNames.length} chỉ báo có sẵn (trong đó ${nDeriv} từ dữ liệu phái sinh: funding, open interest, long/short)`);

  // 2. genetic programming: invent new indicators
  log('\n[2/4] Tự tạo chỉ báo mới bằng genetic programming (chỉ dùng train + validation)...');
  const rand = rng(opt.seed * 7919 + (market === 'spot' ? 1 : 2));
  const gpCtx = makeGpContext(series.slice(0, 12)); // fitness on the 12 most liquid coins keeps GP fast
  const evolved = evolveIndicators(gpCtx, { rand, from: WARMUP, trainEnd: tv, valEnd: hs, population: 160, generations: 10, keep: 12 });
  evolved.forEach((e, k) => {
    series.forEach((s, si) => ranksBySymbol[si].push(rollingRank(indicatorSeries(e.expr, s))));
    featureNames.push(`gp${k + 1}`);
    log(`  gp${k + 1} = ${e.text}   (IC train ${f(e.trainIc, 4)}, validation ${f(e.valIc, 4)})`);
  });
  if (!evolved.length) log('  (không có công thức nào giữ được dấu dự báo ngoài train — bỏ qua)');

  // 3. rule evolution + classic grids
  log(`\n[3/4] Tiến hóa luật từ ${featureNames.length} chỉ báo (${opt.islands} đảo × ${opt.pop} cá thể × ${opt.gens} thế hệ)...`);
  const hall = new Map();
  for (let isl = 0; isl < opt.islands; isl++) {
    const h = evolveRules({
      rand: rng(opt.seed * 104729 + isl * 31 + (market === 'spot' ? 3 : 5)),
      nFeatures: featureNames.length,
      ranksBySymbol,
      ctx,
      trainEnd: tv,
      minTrades: minTrain,
      exits: E0,
      population: opt.pop,
      generations: opt.gens,
      log: isl === 0 ? log : () => {},
    });
    for (const [k, v] of h) if (!hall.has(k)) hall.set(k, v);
    log(`  đảo ${isl + 1}/${opt.islands} xong — tổng ${hall.size} luật đã thử`);
  }
  const topRules = [...hall.values()].filter((x) => x.fit > -900).sort((a, b) => b.fit - a.fit).slice(0, 250);

  const candidates = [];
  const exitSearch = (sigsTrain) => {
    let best = null;
    for (const ex of EXIT_GRID) {
      const r = evalSigs(sigsTrain, ex, ctx, WARMUP, tv);
      if (r.trades >= minTrain && (!best || r.score > best.r.score)) best = { ex, r };
    }
    return best;
  };
  for (const { rule } of topRules) {
    const sigsTrain = ranksBySymbol.map((R) => ruleSignals(rule, R, n, tv));
    const best = exitSearch(sigsTrain);
    if (!best) continue;
    candidates.push({
      kind: 'rule',
      desc: describeRule(rule, featureNames),
      sigs: () => ranksBySymbol.map((R) => ruleSignals(rule, R, n, n)),
      exits: best.ex,
      train: best.r,
      rule,
    });
  }
  const classic = [];
  for (const def of Object.values(STRATEGIES)) {
    for (const sp of def.grid) {
      const sigs = series.map((s) => def.signals(s, sp));
      const best = exitSearch(sigs);
      if (best) classic.push({ kind: 'classic', desc: `${def.label} ${JSON.stringify(sp)}`, sigs: () => sigs, exits: best.ex, train: best.r });
    }
  }
  classic.sort((a, b) => b.train.score - a.train.score);
  candidates.push(...classic.slice(0, 100));
  log(`  ${topRules.length} luật + ${Math.min(100, classic.length)} chiến lược cổ điển vào vòng validation (${EXIT_GRID.length} kiểu thoát lệnh được tối ưu trên train)`);

  // 4. funnel
  log('\n[4/4] Phễu lọc: train → validation → hold-out');
  const validated = [];
  for (const c of candidates) {
    if (c.train.score <= 0) continue;
    const sigs = c.sigs();
    const v = evalSigs(sigs, c.exits, ctx, tv, hs);
    if (v.trades >= minVal && v.ret > 0 && v.breadth >= 0.5 && v.score > 0) validated.push({ ...c, sigsFull: sigs, val: v, rank: Math.min(c.train.score, v.score) });
  }
  validated.sort((a, b) => b.rank - a.rank);
  log(`  vào validation: ${candidates.length} · qua validation (lãi + ≥50% coin lãi): ${validated.length}`);
  const finalists = validated.slice(0, opt.finalists);
  if (!finalists.length) log('  → không ứng viên nào sống sót qua validation.');

  const bh = series.reduce((a, s) => a + buyAndHold(s, hs, n), 0) / series.length;
  const rows = finalists.map((c) => {
    const h = evalSigs(c.sigsFull, c.exits, ctx, hs, n, true);
    const eq = portfolioEquity(h.curves, hs, n);
    const ps = periodStats(t.slice(hs, n), eq);
    const tstat = tStat(h.pnls);
    const pass = h.ret > 0 && tstat >= T_MIN && h.breadth >= 0.5 && h.trades * series.length >= 30;
    return { c, h, ps, tstat, pass };
  });

  if (rows.length) {
    log(`\nHOLD-OUT ${day(t[hs])} → ${day(t[n - 1])} (giữ coin trung bình: ${f(bh)}%)`);
    log('#  Train  Valid | Hold-out ret  MaxDD  Lệnh  Thắng  t-stat | Tuần lãi  Tháng lãi  Tháng tệ nhất | Kết luận');
    rows.forEach((r, i) => {
      log(
        `${String(i + 1).padEnd(3)}${f(r.c.train.score).padEnd(6)} ${f(r.c.val.score).padEnd(6)} | ` +
          `${(f(r.h.ret) + '%').padEnd(12)} ${(f(r.h.maxDD) + '%').padEnd(6)} ${String(Math.round(r.h.trades * series.length)).padEnd(5)} ${(f(r.h.winRate, 0) + '%').padEnd(6)} ${f(r.tstat).padEnd(6)} | ` +
          `${(f(r.ps.weekly.positivePct, 0) + '%').padEnd(9)}${(f(r.ps.monthly.positivePct, 0) + '%').padEnd(11)}${(f(r.ps.monthly.worst) + '%').padEnd(14)}| ${r.pass ? '✔ ĐẠT' : '✘ không đạt'}`,
      );
    });
    log('\nChi tiết:');
    rows.forEach((r, i) => log(`  #${i + 1} [${r.c.kind}] ${r.c.desc}\n      thoát lệnh: SL ${r.c.exits.slMult}×ATR ${r.c.exits.trail ? 'trailing' : r.c.exits.tpMult ? `TP ${r.c.exits.tpMult}×ATR` : 'đảo chiều'}  · chuỗi tuần lỗ dài nhất ${r.ps.weekly.longestLosingStreak}, tuần lỗ nặng nhất ${f(r.ps.weekly.worst)}%`));
  }

  const passed = rows.filter((r) => r.pass);
  log(
    passed.length
      ? `\n✔ ${passed.length}/${rows.length} ứng viên đạt chuẩn trên hold-out (lãi, t-stat ≥ ${T_MIN}, ≥50% coin lãi).`
      : `\n✘ KHÔNG có ứng viên nào đạt chuẩn trên hold-out. Nghĩa là trong dữ liệu này chưa tìm thấy lợi thế đủ tin cậy — không nên giao dịch theo kết quả tìm kiếm.`,
  );

  // current signals (last closed bar) for passing candidates
  const signals = [];
  const shown = passed.length ? passed.slice(0, 3) : opt.forceSignals ? rows.slice(0, 1) : [];
  for (const r of shown) {
    const list = [];
    series.forEach((s, si) => {
      const dir = r.c.sigsFull[si][n - 1];
      if (dir === 0 || (dir === -1 && !MARKETS[market].allowShort)) return;
      const entry = s.c[n - 1];
      const dist = r.c.exits.slMult * atrs[si][n - 1];
      list.push({ symbol: s.symbol, side: dir === 1 ? 'LONG' : 'SHORT', entry, sl: entry - dir * dist, tp: r.c.exits.tpMult ? entry + dir * r.c.exits.tpMult * atrs[si][n - 1] : null, riskSizePct: (0.01 / (dist / entry)) * 100 });
    });
    log(`\nTín hiệu trên nến đóng ${new Date(t[n - 1]).toISOString().slice(0, 16)}Z — ${r.c.desc}${r.pass ? '' : '  [CHƯA ĐƯỢC XÁC THỰC]'}`);
    if (!list.length) log('  (không có tín hiệu mới)');
    list.forEach((g) => log(`  ${g.symbol.padEnd(10)} ${g.side.padEnd(6)} entry≈${g.entry}  SL ${g.sl.toPrecision(6)}  TP ${g.tp ? g.tp.toPrecision(6) : 'theo trailing/đảo chiều'} | rủi ro 1% vốn → khối lượng ≈ ${f(g.riskSizePct)}% vốn`));
    signals.push({ strategy: r.c.desc, exits: r.c.exits, validated: r.pass, list });
  }
  log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return {
    market,
    period: { train: [t[WARMUP], t[tv - 1]], validation: [t[tv], t[hs - 1]], holdout: [t[hs], t[n - 1]] },
    funnel: { candidates: candidates.length, passedValidation: validated.length, finalists: rows.length, passedHoldout: passed.length },
    buyAndHoldHoldout: bh,
    finalists: rows.map((r) => ({ kind: r.c.kind, desc: r.c.desc, exits: r.c.exits, train: r.c.train.score, validation: r.c.val.score, holdout: { ret: r.h.ret, maxDD: r.h.maxDD, trades: r.h.trades * series.length, winRate: r.h.winRate, breadth: r.h.breadth, tstat: r.tstat }, weekly: r.ps.weekly, monthly: r.ps.monthly, monthlyReturns: r.ps.months, pass: r.pass })),
    signals,
    coins: names0,
  };
};

const markets = opt.market === 'both' ? ['spot', 'futures'] : [opt.market];
const results = [];
for (const m of markets) results.push(await analyse(m));
writeFileSync(opt.out, JSON.stringify({ generatedAt: new Date().toISOString(), options: opt, results }, null, 2));
log(`\nĐã lưu: ${opt.out}`);
log('Lưu ý: backtest đã tính phí, trượt giá và funding (futures) nhưng không đảm bảo lợi nhuận tương lai. Luôn đặt stop-loss, bắt đầu bằng vốn nhỏ.');
