#!/usr/bin/env node
// Walk-forward search for the best strategy on Binance spot / futures.
//   node research/run.js [--market spot|futures|both] [--interval 1h] [--bars 5000]
//        [--symbols BTCUSDT,ETHUSDT,...] [--train 1500] [--test 500] [--out file.json] [--synthetic]
import { writeFileSync } from 'node:fs';
import { STRATEGIES, EXIT_GRID, MARKETS, WARMUP, atr, runBacktest, buyAndHold } from './lib.js';
import { fetchSeries, syntheticSeries } from './data.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split(/--/)
    .filter(Boolean)
    .map((a) => {
      const [k, ...rest] = a.trim().split(/\s+/);
      return [k, rest.join(' ') || true];
    }),
);
const opt = {
  market: args.market || 'both',
  interval: args.interval || '1h',
  bars: +args.bars || 5000,
  symbols: (args.symbols || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT').split(','),
  train: +args.train || 1500,
  test: +args.test || 500,
  out: args.out || 'research-results.json',
  synthetic: !!args.synthetic,
};
const MIN_TRADES = 8;
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '∞');

const loadAll = async (market) => {
  if (opt.synthetic) return opt.symbols.map((sym, i) => syntheticSeries(sym, opt.bars, 1000 + i));
  const out = [];
  for (const sym of opt.symbols) {
    try {
      out.push(await fetchSeries(market, sym, opt.interval, opt.bars));
    } catch (e) {
      console.warn(`  bỏ qua ${sym}: ${e.message}`);
    }
  }
  return out;
};

// candidate = strategy family + its params + exit params
const buildCandidates = (seriesList) => {
  const atrs = seriesList.map((s) => atr(s, 14));
  const cands = [];
  for (const [family, def] of Object.entries(STRATEGIES)) {
    for (const sp of def.grid) {
      const sigs = seriesList.map((s) => def.signals(s, sp));
      for (const ex of EXIT_GRID) cands.push({ family, sp, ex, sigs });
    }
  }
  return { cands, atrs };
};

// one parameter set evaluated on every symbol over [from, to)
const evaluate = (cand, seriesList, atrs, market, from, to) => {
  const rs = seriesList.map((s, i) => runBacktest(s, cand.sigs[i], atrs[i], cand.ex, market, from, to));
  const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  return { ret: avg('ret'), maxDD: avg('maxDD'), score: avg('score'), trades: avg('trades'), winRate: avg('winRate') };
};

const bestOn = (cands, seriesList, atrs, market, from, to) => {
  let best = null;
  for (const c of cands) {
    const r = evaluate(c, seriesList, atrs, market, from, to);
    if (r.trades >= MIN_TRADES && (!best || r.score > best.r.score)) best = { c, r };
  }
  return best;
};

const describe = (c) => `${JSON.stringify(c.sp)} SL ${c.ex.slMult}xATR TP ${c.ex.tpMult ? c.ex.tpMult + 'xATR' : 'đảo chiều'}`;

const analyse = async (market) => {
  console.log(`\n=== ${market.toUpperCase()} (${opt.interval}, ${opt.bars} nến, phí ${MARKETS[market].fee * 100}%/chiều) ===`);
  const seriesList = await loadAll(market);
  if (!seriesList.length) return null;
  const n = Math.min(...seriesList.map((s) => s.c.length));
  const trimmed = seriesList.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.slice(-n) : v])));
  const { cands, atrs } = buildCandidates(trimmed);
  console.log(`${trimmed.length} coin, ${n} nến, ${cands.length} tổ hợp tham số`);

  const folds = [];
  for (let ts = WARMUP; ts + opt.train + opt.test <= n; ts += opt.test) folds.push([ts, ts + opt.train, ts + opt.train + opt.test]);
  if (!folds.length) throw new Error('Không đủ dữ liệu cho walk-forward: tăng --bars hoặc giảm --train/--test');

  const families = {};
  for (const family of Object.keys(STRATEGIES)) {
    const fc = cands.filter((c) => c.family === family);
    const oos = folds.map(([a, b, c]) => {
      const pick = bestOn(fc, trimmed, atrs, market, a, b);
      if (!pick) return { ret: 0, maxDD: 0, trades: 0, bh: 0 };
      const r = evaluate(pick.c, trimmed, atrs, market, b, c);
      const bh = trimmed.reduce((acc, s) => acc + buyAndHold(s, b, c), 0) / trimmed.length;
      return { ...r, bh };
    });
    const mean = (k) => oos.reduce((a, r) => a + r[k], 0) / oos.length;
    families[family] = {
      oos,
      meanRet: mean('ret'),
      meanDD: mean('maxDD'),
      bh: mean('bh'),
      trades: oos.reduce((a, r) => a + r.trades, 0),
      profitable: oos.filter((r) => r.ret > 0).length,
      score: mean('ret') - 1.5 * mean('maxDD'),
    };
  }

  console.log(`Walk-forward: ${folds.length} cửa sổ (train ${opt.train} / test ${opt.test} nến) — chỉ tính kết quả OUT-OF-SAMPLE\n`);
  console.log('Chiến lược'.padEnd(30) + 'OOS ret/cửa sổ'.padEnd(17) + 'MaxDD'.padEnd(9) + 'Cửa sổ lãi'.padEnd(13) + 'Giữ coin'.padEnd(11) + 'Lệnh');
  const ranked = Object.entries(families).sort((a, b) => b[1].score - a[1].score);
  for (const [name, r] of ranked) {
    console.log(
      STRATEGIES[name].label.padEnd(30) +
        `${f(r.meanRet)}%`.padEnd(17) +
        `${f(r.meanDD)}%`.padEnd(9) +
        `${r.profitable}/${folds.length}`.padEnd(13) +
        `${f(r.bh)}%`.padEnd(11) +
        Math.round(r.trades),
    );
  }

  const [bestName, best] = ranked[0];
  const robust = best.meanRet > 0 && best.profitable / folds.length >= 0.6 && best.trades >= folds.length * MIN_TRADES;
  const final = bestOn(cands.filter((c) => c.family === bestName), trimmed, atrs, market, n - opt.train, n);

  console.log(
    robust
      ? `\n✔ Ứng viên tốt nhất: ${STRATEGIES[bestName].label} — có lãi ngoài mẫu ở ${best.profitable}/${folds.length} cửa sổ.`
      : `\n✘ Chưa tìm thấy lợi thế đáng tin: chiến lược tốt nhất (${STRATEGIES[bestName].label}) không đủ ổn định ngoài mẫu. KHÔNG nên giao dịch theo nó.`,
  );

  const signals = [];
  if (final) {
    console.log(`Tham số (tối ưu trên ${opt.train} nến gần nhất): ${describe(final.c)}`);
    trimmed.forEach((s, i) => {
      const last = n - 1;
      const dir = final.c.sigs[i][last];
      if (dir === 0 || (dir === -1 && !MARKETS[market].allowShort)) return;
      const entry = s.c[last];
      const dist = final.c.ex.slMult * atrs[i][last];
      signals.push({
        symbol: s.symbol,
        side: dir === 1 ? 'LONG' : 'SHORT',
        entry,
        sl: entry - dir * dist,
        tp: final.c.ex.tpMult ? entry + dir * final.c.ex.tpMult * atrs[i][last] : null,
        riskSizePct: (0.01 / (dist / entry)) * 100,
      });
    });
    console.log(signals.length ? '\nTín hiệu trên nến đóng gần nhất (vào lệnh thủ công, giá chỉ để tham khảo):' : '\nHiện không có tín hiệu mới.');
    for (const g of signals) {
      console.log(
        `  ${g.symbol.padEnd(10)} ${g.side.padEnd(6)} entry≈${g.entry}  SL ${g.sl.toPrecision(6)}  TP ${g.tp ? g.tp.toPrecision(6) : 'theo tín hiệu đảo'}  | rủi ro 1% vốn → khối lượng ≈ ${f(g.riskSizePct)}% vốn`,
      );
    }
  }
  return { market, robust, best: bestName, params: final && { sp: final.c.sp, ex: final.c.ex }, families: Object.fromEntries(ranked.map(([k, v]) => [k, { ...v, oos: undefined }])), signals };
};

const markets = opt.market === 'both' ? ['spot', 'futures'] : [opt.market];
const results = [];
for (const m of markets) {
  const r = await analyse(m);
  if (r) results.push(r);
}
writeFileSync(opt.out, JSON.stringify({ generatedAt: new Date().toISOString(), options: opt, results }, null, 2));
console.log(`\nĐã lưu kết quả: ${opt.out}`);
console.log('Lưu ý: backtest không đảm bảo lợi nhuận tương lai; chưa tính funding futures. Luôn đặt stop-loss và chỉ dùng vốn chấp nhận mất.');
