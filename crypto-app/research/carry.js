#!/usr/bin/env node
// Funding carry (cash-and-carry): buy the coin on spot and short the same amount of the USDT-M
// perpetual. Price moves cancel; the position collects funding (longs pay shorts when funding > 0)
// and pays it when funding turns negative. Simulated hourly since 2021 with real spot / perp prices
// (basis risk included), Binance fees on all four legs and capital split 50/50 (1x short).
//
//   node research/carry.js [--symbols ...] [--from 2021-01] [--split 2024-01] [--out carry-results.json]
import { writeFileSync } from 'node:fs';
import { fetchSpotHistory, fetchFuturesHistory, fetchFunding } from './data.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';

const args = parseArgs(process.argv.slice(2));
const SYMBOLS = args.symbols ? args.symbols.split(',') : DEFAULT_UNIVERSE;
const FROM = Date.parse(`${args.from || '2021-01'}-01T00:00:00Z`);
const SPLIT = Date.parse(`${args.split || '2024-01'}-01T00:00:00Z`);
const OUT = args.out || 'carry-results.json';
const H = 3_600_000;
const DAY = 24;
const COST = 0.001 + 0.0005 + 2 * 0.0002; // spot taker + futures taker + slippage on both legs, per side
const HEDGE = 0.5; // half the capital buys spot, half is margin for a 1x short → notional = 50% of capital
const MAJORS = DEFAULT_UNIVERSE.slice(0, 12);
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// ---------- data on one hourly grid ----------
log(`Tải giá spot, giá futures và funding cho ${SYMBOLS.length} coin...`);
const coins = [];
for (const sym of SYMBOLS) {
  try {
    const [s, p, fu] = await Promise.all([fetchSpotHistory(sym, '1h', FROM), fetchFuturesHistory(sym, '1h', FROM), fetchFunding(sym, FROM)]);
    if (s.t.length < 24 * 60 || p.t.length < 24 * 60) continue;
    coins.push({ sym, s, p, fu });
    process.stdout.write(`${sym} `);
  } catch (e) {
    log(`\n  bỏ ${sym}: ${e.message.slice(0, 80)}`);
  }
}
const END = Math.min(...coins.map((c) => Math.min(c.s.t[c.s.t.length - 1], c.p.t[c.p.t.length - 1])));
const N = Math.floor((END - FROM) / H) + 1;
const T = Float64Array.from({ length: N }, (_, i) => FROM + i * H);
const grid = coins.map((c) => {
  const S = new Float64Array(N).fill(NaN);
  const P = new Float64Array(N).fill(NaN);
  const R = new Float64Array(N); // funding rate charged during hour i
  c.s.t.forEach((t, k) => {
    const i = Math.round((t - FROM) / H);
    if (i >= 0 && i < N) S[i] = c.s.c[k];
  });
  c.p.t.forEach((t, k) => {
    const i = Math.round((t - FROM) / H);
    if (i >= 0 && i < N) P[i] = c.p.c[k];
  });
  for (const [t, rate] of c.fu) {
    const i = Math.floor((t - FROM) / H);
    if (i >= 0 && i < N) R[i] += rate;
  }
  // forward-fill isolated missing hours so one missing candle does not break a position
  for (let i = 1; i < N; i++) {
    if (Number.isNaN(S[i]) && !Number.isNaN(S[i - 1]) && i - 1 >= 0) S[i] = S[i - 1];
    if (Number.isNaN(P[i]) && !Number.isNaN(P[i - 1])) P[i] = P[i - 1];
  }
  return { sym: c.sym, S, P, R };
});
log(`\n${grid.length} coin · ${N} giờ (${new Date(FROM).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)})\n`);

// ---------- raw funding statistics ----------
const years = [...new Set([...T].map((t) => new Date(t).getUTCFullYear()))];
const aprByYear = (g, y) => {
  let sum = 0;
  let hours = 0;
  let neg = 0;
  let events = 0;
  for (let i = 0; i < N; i++) {
    if (new Date(T[i]).getUTCFullYear() !== y || Number.isNaN(g.P[i])) continue;
    sum += g.R[i];
    hours++;
    if (g.R[i] !== 0) {
      events++;
      if (g.R[i] < 0) neg++;
    }
  }
  return hours > 24 * 30 ? { apr: (sum / hours) * 24 * 365 * 100, negPct: events ? (neg / events) * 100 : 0 } : null;
};
log('Funding trung bình (lợi suất/năm trên giá trị vị thế) — % số lần funding âm:');
for (const name of ['BTCUSDT', 'ETHUSDT']) {
  const g = grid.find((x) => x.sym === name);
  if (g) log(`  ${name.padEnd(9)} ${years.map((y) => { const r = aprByYear(g, y); return r ? `${y}: ${f(r.apr)}% (âm ${f(r.negPct, 0)}%)` : ''; }).join(' · ')}`);
}
log(`  Trung vị altcoin ${years.map((y) => {
  const xs = grid.filter((g) => !['BTCUSDT', 'ETHUSDT'].includes(g.sym)).map((g) => aprByYear(g, y)).filter(Boolean).map((r) => r.apr).sort((a, b) => a - b);
  return xs.length ? `${y}: ${f(xs[Math.floor(xs.length / 2)])}%` : '';
}).join(' · ')}`);

// ---------- strategy simulation ----------
// v = { universe: Set of coin indices, mode: 'all' | 'top', K, thr (APR, fraction), W (days), R (days) }
const simulate = (v, from, to) => {
  let cash = 1;
  const pos = new Map(); // coin -> { q, cap }
  const daily = [];
  let costs = 0;
  let fundingIn = 0;
  let basisPnl = 0;
  let dayCount = 0;
  let danger = 0; // short leg would be at risk of liquidation (perp up ≥ 80% since the last rebalance)
  const equity = () => cash + [...pos.values()].reduce((a, p) => a + p.cap, 0);
  for (let i = from; i < to; i++) {
    // hourly P&L of open positions (prices from i-1 to i, funding charged during hour i)
    for (const [c, p] of pos) {
      const g = grid[c];
      const b = p.q * (g.S[i] - g.S[i - 1]) - p.q * (g.P[i] - g.P[i - 1]);
      const fu = p.q * g.P[i - 1] * g.R[i];
      if (Number.isFinite(b)) {
        p.cap += b;
        basisPnl += b;
      }
      p.cap += fu;
      fundingIn += fu;
      if (!p.flagged && g.P[i] >= p.refP * 1.8) {
        danger++;
        p.flagged = true;
      }
    }
    // daily decision at 00:00 UTC
    if (T[i] % (DAY * H) === 0) {
      if (dayCount % v.R === 0) {
        const lookH = v.W * DAY;
        const scores = [];
        for (const c of v.universe) {
          const g = grid[c];
          if (Number.isNaN(g.S[i]) || Number.isNaN(g.P[i]) || i - lookH < 0 || Number.isNaN(g.P[i - lookH])) continue;
          let sum = 0;
          for (let k = i - lookH; k < i; k++) sum += g.R[k];
          scores.push([c, (sum / v.W) * 365]);
        }
        let chosen = v.mode === 'all' ? scores : scores.sort((a, b) => b[1] - a[1]).slice(0, v.K);
        if (v.thr !== null) chosen = chosen.filter(([, apr]) => apr > v.thr);
        const want = new Set(chosen.map(([c]) => c));
        // close positions no longer wanted
        for (const [c, p] of [...pos]) {
          if (want.has(c)) continue;
          const cost = p.q * grid[c].P[i] * COST;
          cash += p.cap - cost;
          costs += cost;
          pos.delete(c);
        }
        // open new ones with an equal share of current equity
        const slot = want.size ? equity() / want.size : 0;
        for (const c of want) {
          if (pos.has(c)) continue;
          const cap = Math.min(cash, slot);
          if (cap <= 0) continue;
          const notional = cap * HEDGE;
          const cost = notional * COST;
          cash -= cap;
          costs += cost;
          pos.set(c, { q: notional / grid[c].S[i], cap: cap - cost, refP: grid[c].P[i] });
        }
      }
      // daily rebalance: keep each hedge at 50% of its capital (move spot profits to futures margin)
      for (const [c, p] of pos) {
        const g = grid[c];
        const target = (p.cap * HEDGE) / g.S[i];
        if (Math.abs(target - p.q) > 0.1 * p.q) {
          const cost = Math.abs(target - p.q) * g.S[i] * COST;
          p.cap -= cost;
          costs += cost;
          p.q = (p.cap * HEDGE) / g.S[i];
          p.refP = g.P[i];
          p.flagged = false;
        }
      }
      dayCount++;
      daily.push([T[i], equity()]);
    }
  }
  // close everything at the end
  for (const [c, p] of pos) {
    const cost = p.q * grid[c].P[to - 1] * COST;
    cash += p.cap - cost;
    costs += cost;
  }
  daily.push([T[to - 1], cash]);
  return stats(daily, { costs, fundingIn, basisPnl, danger });
};

const stats = (daily, extra) => {
  let peak = 1;
  let mdd = 0;
  for (const [, e] of daily) {
    peak = Math.max(peak, e);
    mdd = Math.max(mdd, 1 - e / peak);
  }
  const first = new Map();
  const yFirst = new Map();
  let prev = daily[0][1];
  for (const [t, e] of daily) {
    const m = new Date(t).toISOString().slice(0, 7);
    if (!first.has(m)) first.set(m, prev);
    if (!yFirst.has(m.slice(0, 4))) yFirst.set(m.slice(0, 4), prev);
    prev = e;
  }
  const end = daily[daily.length - 1][1];
  const per = (map) => {
    const ks = [...map.keys()];
    return ks.map((k, j) => [k, ((j + 1 < ks.length ? map.get(ks[j + 1]) : end) / map.get(k) - 1) * 100]);
  };
  const months = per(first);
  const weeks = [];
  for (let k = 7; k < daily.length; k += 7) weeks.push((daily[k][1] / daily[k - 7][1] - 1) * 100);
  const yearsN = (daily[daily.length - 1][0] - daily[0][0]) / (365 * 86_400_000);
  const start = daily[0][1];
  return {
    total: (end / start - 1) * 100,
    cagr: ((end / start) ** (1 / yearsN) - 1) * 100,
    maxDD: mdd * 100,
    monthsPos: (months.filter(([, r]) => r > 0).length / months.length) * 100,
    weeksPos: (weeks.filter((r) => r > 0).length / weeks.length) * 100,
    worstMonth: Math.min(...months.map(([, r]) => r)),
    worstWeek: Math.min(...weeks),
    years: per(yFirst),
    months,
    fundingPct: extra.fundingIn * 100,
    basisPct: extra.basisPnl * 100,
    costPct: extra.costs * 100,
    danger: extra.danger,
  };
};

const idx = (list) => new Set(grid.map((g, k) => (list.includes(g.sym) ? k : -1)).filter((k) => k >= 0));
const UNIVERSES = { 'BTC+ETH': idx(['BTCUSDT', 'ETHUSDT']), '12 coin lớn': idx(MAJORS), [`${grid.length} coin`]: new Set(grid.map((_, k) => k)) };
const variants = [];
for (const [uName, universe] of Object.entries(UNIVERSES)) {
  for (const R of [1, 7]) {
    variants.push({ uName, universe, mode: 'all', K: 0, thr: null, W: 7, R });
    for (const W of [3, 7, 14]) variants.push({ uName, universe, mode: 'all', K: 0, thr: 0, W, R });
    if (universe.size > 2)
      for (const K of [3, 5, 10]) for (const thr of [0, 0.1, 0.2]) for (const W of [3, 7, 14]) variants.push({ uName, universe, mode: 'top', K, thr, W, R });
  }
}
const describe = (v) =>
  `${v.uName}: ${v.mode === 'all' ? (v.thr === null ? 'giữ tất cả, luôn luôn' : `giữ coin có funding ${v.W} ngày qua > 0`) : `giữ ${v.K} coin funding cao nhất (${v.W} ngày qua) nếu > ${v.thr * 100}%/năm`} · xét lại mỗi ${v.R === 1 ? 'ngày' : 'tuần'}`;

const splitIdx = Math.floor((SPLIT - FROM) / H);
const lookStart = 15 * DAY + 1;
const res = variants.map((v) => ({ v, A: simulate(v, lookStart, splitIdx), B: simulate(v, splitIdx, N), ALL: simulate(v, lookStart, N) }));

const line = (r) =>
  `lãi/năm ${f(r.cagr).padStart(5)}% · sụt tối đa ${f(r.maxDD)}% · tháng lãi ${f(r.monthsPos, 0)}% · tuần lãi ${f(r.weeksPos, 0)}% · tháng tệ nhất ${f(r.worstMonth)}%`;
log(`\nĐã mô phỏng ${variants.length} cách vận hành. Vốn chia đôi: 50% mua spot, 50% ký quỹ short futures 1x. Phí 4 chiều ${f(COST * 200, 2)}% mỗi lần vào+ra.`);
log(`Giai đoạn A: ${new Date(FROM).toISOString().slice(0, 7)} → ${new Date(SPLIT).toISOString().slice(0, 7)} · Giai đoạn B: ${new Date(SPLIT).toISOString().slice(0, 7)} → nay\n`);

const show = (title, list) => {
  log(title);
  for (const r of list) {
    log(` • ${describe(r.v)}`);
    log(`   A: ${line(r.A)}`);
    log(`   B: ${line(r.B)}`);
    log(`   cả giai đoạn theo năm: ${r.ALL.years.map(([y, x]) => `${y} ${f(x)}%`).join(' · ')}  (funding ${f(r.ALL.fundingPct, 0)}%, chênh giá ${f(r.ALL.basisPct, 0)}%, phí −${f(r.ALL.costPct, 0)}%, ${r.ALL.danger} lần có nguy cơ bị thanh lý)`);
  }
  log('');
};
show('1) Đơn giản nhất — giữ carry liên tục, không chọn lọc:', res.filter((r) => r.v.mode === 'all' && r.v.thr === null && r.v.R === 7));
show('2) Chỉ giữ khi funding gần đây dương:', res.filter((r) => r.v.mode === 'all' && r.v.thr === 0 && r.v.W === 7 && r.v.R === 1));
const top = [...res].filter((r) => r.v.mode === 'top').sort((a, b) => b.A.cagr - a.A.cagr);
show('3) 5 cách chọn coin tốt nhất ở giai đoạn A → kết quả ở giai đoạn B (kiểm tra thật):', top.slice(0, 5));
const robust = [...res].sort((a, b) => Math.min(b.A.cagr, b.B.cagr) - Math.min(a.A.cagr, a.B.cagr));
show('4) Ổn định nhất (lợi suất tốt ở CẢ HAI giai đoạn):', robust.slice(0, 5));

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), coins: grid.map((g) => g.sym), results: res.map((r) => ({ rule: describe(r.v), A: r.A, B: r.B, ALL: r.ALL })) }, null, 1));
log(`Đã lưu: ${OUT}`);
