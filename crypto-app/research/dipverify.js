#!/usr/bin/env node
// Stress-tests the "buy a crash, sell a small bounce" family found by dipstudy.js:
//   - fill realism: price must trade 0.1% / 0.5% / 1% / 2% through the limit order
//   - manual entry: buy at the NEXT candle's open after the crash is seen (no resting order)
//   - concentration: how much of the profit comes from the 10 best days
//   - one shared capital pool (10% per trade, max 10 positions): yearly / monthly results
//
//   node research/dipverify.js [--symbols ...] [--from 2021-01] [--out dipverify-results.json]
import { writeFileSync } from 'node:fs';
import { loadSpotHistoryCached, segmentEnds } from './data.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';
import { tStat } from './stats.js';

const args = parseArgs(process.argv.slice(2));
const MEMES = ['PEPEUSDT', 'SHIBUSDT', 'FLOKIUSDT', 'BONKUSDT', 'WIFUSDT'];
const SYMBOLS = args.symbols ? args.symbols.split(',') : [...DEFAULT_UNIVERSE, ...MEMES];
const MAJORS = new Set(DEFAULT_UNIVERSE.slice(0, 12));
const FROM = Date.parse(`${args.from || '2021-01'}-01T00:00:00Z`);
const OUT = args.out || 'dipverify-results.json';
const BAR_MIN = 5;
const FEE = 0.001;
const SLIP = 0.0005;

const VARIANTS = [];
for (const d of [0.08, 0.12, 0.15, 0.2])
  for (const l of [12, 48])
    for (const t of [0.02, 0.03, 0.05])
      for (const s of [0, 0.2]) VARIANTS.push({ d, l, t, s, h: 288 });
const THROUGH = [0.001, 0.005, 0.01, 0.02];
const MODES = ['limit', 'nextOpen'];
const CONFIGS = [];
for (const v of VARIANTS) for (const th of THROUGH) for (const mode of MODES) CONFIGS.push({ ...v, th, mode });
const label = (c) =>
  `giảm ${c.d * 100}% so với đỉnh ${(c.l * BAR_MIN) / 60}h · chốt +${c.t * 100}% · ${c.s ? `cắt lỗ −${c.s * 100}%` : 'không cắt lỗ'} · tối đa 1 ngày · ${c.mode === 'limit' ? `lệnh chờ (giá xuyên ${c.th * 100}%)` : 'mua tay ở nến sau'}`;

const load = (sym) => loadSpotHistoryCached(sym, `${BAR_MIN}m`, FROM);

const rollingMax = (h, w) => {
  const out = new Float64Array(h.length).fill(NaN);
  const q = new Int32Array(h.length);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < h.length; i++) {
    while (head < tail && q[head] < i - w) head++;
    if (i >= w) out[i] = h[q[head]];
    while (head < tail && h[q[tail - 1]] <= h[i]) tail--;
    q[tail++] = i;
  }
  return out;
};

// trades[cfg] = flat arrays of entryTime, exitTime, return, coinIndex
const trades = CONFIGS.map(() => ({ te: [], tx: [], r: [], ci: [] }));

const run = (s, ci) => {
  const n = s.c.length;
  const maxes = { 12: rollingMax(s.h, 12), 48: rollingMax(s.h, 48) };
  const segEnd = segmentEnds(s.t, 30 * 60_000);
  CONFIGS.forEach((c, k) => {
    const mx = maxes[c.l];
    const T = trades[k];
    let i = c.l;
    while (i < n - 2) {
      const level = mx[i] * (1 - c.d);
      if (!(s.l[i] <= level * (1 - c.th))) {
        i++;
        continue;
      }
      if (c.mode === 'nextOpen' && segEnd[i] === i) {
        i++;
        continue;
      }
      let e;
      let j; // bar after which exits are checked
      if (c.mode === 'limit') {
        e = Math.min(s.o[i], level);
        j = i;
      } else {
        // seen at the close of bar i, market-buy at the open of bar i+1
        e = s.o[i + 1] * (1 + SLIP);
        j = i + 1;
      }
      const tp = e * (1 + c.t);
      const sl = c.s ? e * (1 - c.s) : 0;
      const last = Math.min(segEnd[j], j + c.h);
      let k2 = last;
      let px = s.c[last] * (1 - SLIP);
      for (let q = j + 1; q <= last; q++) {
        if (c.s && s.l[q] <= sl) {
          k2 = q;
          px = Math.min(s.o[q], sl) * (1 - SLIP);
          break;
        }
        if (s.h[q] >= tp * (1 + c.th)) {
          k2 = q;
          px = Math.max(s.o[q], tp);
          break;
        }
      }
      T.te.push(s.t[i]);
      T.tx.push(s.t[k2] + BAR_MIN * 60_000);
      T.r.push((px / e) * (1 - FEE) * (1 - FEE) - 1);
      T.ci.push(ci);
      i = k2 + 1;
    }
  });
};

// one shared pool: each trade takes 10% of equity at entry, at most 10 open positions
const pool = (T, frac = 0.1, maxOpen = 10) => {
  const idx = T.te.map((_, k) => k).sort((a, b) => T.te[a] - T.te[b]);
  let cash = 1;
  const open = []; // {tx, stake, r}
  const curve = [];
  let taken = 0;
  const settle = (until) => {
    open.sort((a, b) => a.tx - b.tx);
    while (open.length && open[0].tx <= until) {
      const p = open.shift();
      cash += p.stake * (1 + p.r);
      curve.push([p.tx, cash + open.reduce((a, q) => a + q.stake, 0)]);
    }
  };
  for (const k of idx) {
    settle(T.te[k]);
    if (open.length >= maxOpen) continue;
    const equity = cash + open.reduce((a, q) => a + q.stake, 0);
    const stake = Math.min(cash, equity * frac);
    if (stake <= 0) continue;
    cash -= stake;
    open.push({ tx: T.tx[k], stake, r: T.r[k] });
    taken++;
  }
  settle(Infinity);
  let peak = 1;
  let mdd = 0;
  const byMonth = new Map();
  const byYear = new Map();
  let prev = 1;
  for (const [t, eq] of curve) {
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, 1 - eq / peak);
    const m = new Date(t).toISOString().slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, prev);
    if (!byYear.has(m.slice(0, 4))) byYear.set(m.slice(0, 4), prev);
    prev = eq;
  }
  // month/year returns from first equity of the period to first equity of the next
  const periods = (map) => {
    const keys = [...map.keys()];
    return keys.map((k, q) => [k, ((q + 1 < keys.length ? map.get(keys[q + 1]) : prev) / map.get(k) - 1) * 100]);
  };
  // calendar months without any closed trade count as 0%
  const got = new Map(periods(byMonth));
  const months = [];
  if (curve.length) {
    const d = new Date(curve[0][0]);
    const end = new Date(curve[curve.length - 1][0]).toISOString().slice(0, 7);
    for (let y = d.getUTCFullYear(), m = d.getUTCMonth(); ; m++) {
      if (m === 12) {
        m = 0;
        y++;
      }
      const key = `${y}-${String(m + 1).padStart(2, '0')}`;
      months.push([key, got.get(key) || 0]);
      if (key === end) break;
    }
  }
  return { final: (prev - 1) * 100, maxDD: mdd * 100, taken, months, years: periods(byYear) };
};

const t0 = Date.now();
const coins = [];
for (const sym of SYMBOLS) {
  try {
    const s = await load(sym);
    if (s.c.length < 30 * 288) continue;
    run(s, coins.length);
    coins.push(sym);
    process.stdout.write(`${sym} `);
  } catch (e) {
    console.log(`\nbỏ ${sym}: ${e.message.slice(0, 80)}`);
  }
}
console.log(`\n${coins.length} coin · ${CONFIGS.length} cấu hình · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const summary = CONFIGS.map((c, k) => {
  const T = trades[k];
  const n = T.r.length;
  const mean = n ? T.r.reduce((a, b) => a + b, 0) / n : 0;
  // concentration: profit of the 10 best calendar days
  const byDay = new Map();
  T.r.forEach((r, q) => {
    const d = new Date(T.te[q]).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + r);
  });
  const days = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const total = T.r.reduce((a, b) => a + b, 0);
  const top10 = days.slice(0, 10).reduce((a, [, v]) => a + v, 0);
  const top10Days = new Set(days.slice(0, 10).map(([d]) => d));
  const rest = T.r.filter((_, q) => !top10Days.has(new Date(T.te[q]).toISOString().slice(0, 10)));
  const seg = (pred) => {
    const xs = T.r.filter((_, q) => pred(q));
    return xs.length ? { n: xs.length, mean: (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 } : { n: 0, mean: 0 };
  };
  return {
    cfg: c,
    label: label(c),
    n,
    mean: mean * 100,
    win: n ? (T.r.filter((r) => r > 0).length / n) * 100 : 0,
    t: tStat(T.r),
    worst: n ? Math.min(...T.r) * 100 : 0,
    top10Share: total > 0 ? (top10 / total) * 100 : NaN,
    topDays: days.slice(0, 5).map(([d, v]) => `${d} (${f(v * 100, 0)}%)`),
    meanExTop10: rest.length ? (rest.reduce((a, b) => a + b, 0) / rest.length) * 100 : 0,
    tExTop10: tStat(rest),
    majors: seg((q) => MAJORS.has(coins[T.ci[q]])),
    others: seg((q) => !MAJORS.has(coins[T.ci[q]]) && !MEMES.includes(coins[T.ci[q]])),
    memes: seg((q) => MEMES.includes(coins[T.ci[q]])),
    pool: pool(T),
  };
});

// 1) how results move when fills get stricter / entry is manual
console.log('1) Ảnh hưởng của điều kiện khớp lệnh — trung bình trên 48 biến thể (lãi TB/lệnh, t-stat):');
for (const mode of MODES)
  for (const th of THROUGH) {
    const xs = summary.filter((x) => x.cfg.mode === mode && x.cfg.th === th);
    const m = xs.reduce((a, x) => a + x.mean, 0) / xs.length;
    const pos = xs.filter((x) => x.mean > 0 && x.t >= 3).length;
    console.log(`   ${mode === 'limit' ? 'lệnh chờ' : 'mua tay nến sau'} · giá xuyên ${f(th * 100)}%: lãi TB ${f(m, 2)}%/lệnh · ${pos}/${xs.length} biến thể lãi có ý nghĩa (t≥3)`);
  }

// 2) the most robust configs: judged on the strictest realistic setting
const strict = summary.filter((x) => x.cfg.mode === 'nextOpen' && x.cfg.th === 0.005 && x.n >= 300).sort((a, b) => b.tExTop10 - a.tExTop10);
console.log('\n2) Mua tay ở nến sau (thực tế nhất cho bạn) — 5 biến thể vững nhất, KHÔNG tính 10 ngày lãi nhất:');
for (const x of strict.slice(0, 5)) {
  console.log(` • ${x.label}`);
  console.log(`   ${x.n} lệnh · lãi TB ${f(x.mean, 2)}%/lệnh (t=${f(x.t)}) · thắng ${f(x.win, 0)}% · lệnh tệ nhất ${f(x.worst, 0)}%`);
  console.log(`   10 ngày tốt nhất chiếm ${f(x.top10Share, 0)}% tổng lãi (${x.topDays.slice(0, 3).join(', ')}) · bỏ 10 ngày đó: ${f(x.meanExTop10, 2)}%/lệnh (t=${f(x.tExTop10)})`);
  console.log(`   coin lớn ${f(x.majors.mean, 2)}% (${x.majors.n}) · coin khác ${f(x.others.mean, 2)}% (${x.others.n}) · memecoin ${f(x.memes.mean, 2)}% (${x.memes.n})`);
  console.log(`   VỐN CHUNG (10%/lệnh, tối đa 10 lệnh): tổng ${f(x.pool.final, 0)}% · sụt tối đa ${f(x.pool.maxDD, 0)}% · ${x.pool.taken} lệnh`);
  console.log(`   theo năm: ${x.pool.years.map(([y, r]) => `${y} ${f(r, 0)}%`).join(' · ')}`);
  const ms = x.pool.months.map(([, r]) => r);
  console.log(`   tháng có lãi: ${f((ms.filter((r) => r > 0).length / ms.length) * 100, 0)}% · tháng tệ nhất ${f(Math.min(...ms))}% · tháng tốt nhất ${f(Math.max(...ms))}%`);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), coins, summary }, null, 1));
console.log(`\nĐã lưu: ${OUT}`);
