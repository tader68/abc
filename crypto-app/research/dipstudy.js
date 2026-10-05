#!/usr/bin/env node
// "Buy the dip, sell higher": does it really work? A long-history study across many coins.
//
// Rule family: limit-buy when price falls d% below the highest high of the last L minutes,
// then sell at +t% (take profit), at -s% (stop loss, optional) or after H hours (time stop).
// 720 variants, 5-minute candles since 2021, Binance spot fees (0.1% per side), limit orders
// filled only when price trades 0.1% through them, stops filled at the next candle's open if it gaps.
//
// Every dip trade gets a CONTROL trade: same coin, random moment within ±30 days, same exits.
// If buying dips is a real edge, dip trades must beat their controls — otherwise the profit
// only came from the market going up.
//
//   node research/dipstudy.js [--symbols A,B] [--from 2021-01] [--split 2024-01] [--out dip-results.json]
import { writeFileSync } from 'node:fs';
import { fetchSpotHistory, rng } from './data.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';

const args = parseArgs(process.argv.slice(2));
const MEMES = ['PEPEUSDT', 'SHIBUSDT', 'FLOKIUSDT', 'BONKUSDT', 'WIFUSDT'];
const SYMBOLS = args.symbols ? args.symbols.split(',') : [...DEFAULT_UNIVERSE, ...MEMES];
const FROM = Date.parse(`${args.from || '2021-01'}-01T00:00:00Z`);
const SPLIT = Date.parse(`${args.split || '2024-01'}-01T00:00:00Z`);
const OUT = args.out || 'dip-results.json';
const BAR_MIN = 5;
const FEE = 0.001;
const SLIP = 0.0005; // market exits (stop / time stop)
const THROUGH = 0.001; // a limit order only counts as filled if price trades 0.1% through it
const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];

const D = [0.03, 0.05, 0.08, 0.12]; // dip size below the recent high
const L = [60, 240, 1440].map((m) => m / BAR_MIN); // look-back for the recent high
const T = [0.01, 0.02, 0.03, 0.05, 0.1]; // take profit
const S = [0, 0.05, 0.1, 0.2]; // stop loss (0 = none)
const H = [24, 168, 720].map((h) => (h * 60) / BAR_MIN); // time stop: 1 day, 7 days, 30 days
const VARIANTS = [];
for (const d of D) for (const l of L) for (const t of T) for (const s of S) for (const h of H) VARIANTS.push({ d, l, t, s, h });
const V = VARIANTS.length;
const label = (v) =>
  `mua khi giảm ${v.d * 100}% so với đỉnh ${(v.l * BAR_MIN) / 60}h, chốt +${v.t * 100}%, ${v.s ? `cắt lỗ −${v.s * 100}%` : 'không cắt lỗ'}, giữ tối đa ${(v.h * BAR_MIN) / 60 / 24} ngày`;

// rolling max of highs over the previous w bars (current bar excluded), monotonic deque
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

// exit simulation from bar j (exclusive) for a position entered at price e
const exitFrom = (s, j, e, v) => {
  const tp = e * (1 + v.t);
  const sl = v.s ? e * (1 - v.s) : 0;
  const n = s.c.length;
  const last = Math.min(n - 1, j + v.h);
  for (let k = j + 1; k <= last; k++) {
    if (v.s && s.l[k] <= sl) return { k, px: Math.min(s.o[k], sl) * (1 - SLIP) };
    if (s.h[k] >= tp * (1 + THROUGH)) return { k, px: Math.max(s.o[k], tp) };
  }
  return { k: last, px: s.c[last] * (1 - SLIP) };
};

// accumulators: index = (v * 2 + split)
const A = {
  n: new Float64Array(V * 2),
  sum: new Float64Array(V * 2),
  sumsq: new Float64Array(V * 2),
  wins: new Float64Array(V * 2),
  worst: new Float64Array(V * 2).fill(0),
  ctrl: new Float64Array(V * 2),
  diff: new Float64Array(V * 2),
  diffsq: new Float64Array(V * 2),
  hold: new Float64Array(V * 2),
  yearSum: new Float64Array(V * YEARS.length),
  yearN: new Float64Array(V * YEARS.length),
};
const sleeves = []; // per coin: Float64Array(V * 2) compounded equity of the coin's dip trades
const coinsInSplit = [0, 0];
const holdReturns = [[], []];

const studyCoin = (s, ci) => {
  const n = s.c.length;
  const maxes = L.map((w) => rollingMax(s.h, w));
  const eq = new Float64Array(V * 2).fill(1);
  const rand = rng(1234 + ci);
  const month = (30 * 1440) / BAR_MIN;
  for (let vi = 0; vi < V; vi++) {
    const v = VARIANTS[vi];
    const mx = maxes[L.indexOf(v.l)];
    let i = v.l;
    while (i < n - 1) {
      const level = mx[i] * (1 - v.d);
      if (!(s.l[i] <= level * (1 - THROUGH))) {
        i++;
        continue;
      }
      const e = Math.min(s.o[i], level); // limit order filled (or gapped through)
      const ex = exitFrom(s, i, e, v);
      const r = (ex.px / e) * (1 - FEE) * (1 - FEE) - 1;
      // control: random entry within ±30 days, same exits
      const lo = Math.max(0, i - month);
      const hi = Math.min(n - 2, i + month);
      const j = lo + Math.floor(rand() * (hi - lo));
      const ce = s.c[j];
      const cx = exitFrom(s, j, ce, v);
      const rc = (cx.px / ce) * (1 - FEE) * (1 - FEE) - 1;

      const sp = s.t[i] < SPLIT ? 0 : 1;
      const a = vi * 2 + sp;
      A.n[a]++;
      A.sum[a] += r;
      A.sumsq[a] += r * r;
      if (r > 0) A.wins[a]++;
      if (r < A.worst[a]) A.worst[a] = r;
      A.ctrl[a] += rc;
      A.diff[a] += r - rc;
      A.diffsq[a] += (r - rc) ** 2;
      A.hold[a] += ex.k - i;
      eq[a] *= 1 + r;
      const y = YEARS.indexOf(new Date(s.t[i]).getUTCFullYear());
      if (y >= 0) {
        A.yearSum[vi * YEARS.length + y] += r;
        A.yearN[vi * YEARS.length + y]++;
      }
      i = ex.k + 1;
    }
  }
  sleeves.push(eq);
  // buy & hold of this coin in each split (for reference)
  const cut = s.t.findIndex((x) => x >= SPLIT);
  if (cut !== 0) holdReturns[0].push(s.c[(cut < 0 ? n : cut) - 1] / s.o[0] - 1);
  if (cut >= 0) holdReturns[1].push(s.c[n - 1] / s.o[cut] - 1);
  if (cut !== 0) coinsInSplit[0]++;
  if (cut >= 0) coinsInSplit[1]++;
};

const t0 = Date.now();
const used = [];
for (let ci = 0; ci < SYMBOLS.length; ci++) {
  const sym = SYMBOLS[ci];
  try {
    const s = await fetchSpotHistory(sym, `${BAR_MIN}m`, FROM);
    if (s.c.length < 30 * 288) {
      console.log(`  bỏ ${sym}: quá ít dữ liệu`);
      continue;
    }
    studyCoin(s, ci);
    used.push({ symbol: sym, from: new Date(s.t[0]).toISOString().slice(0, 10), bars: s.c.length });
    console.log(`  ${String(used.length).padStart(2)}. ${sym.padEnd(10)} từ ${used[used.length - 1].from}  ${s.c.length} nến  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    console.log(`  bỏ ${sym}: ${e.message.slice(0, 100)}`);
  }
}

// ---------- results ----------
const stat = (vi, sp) => {
  const a = vi * 2 + sp;
  const n = A.n[a];
  const mean = n ? A.sum[a] / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max(0, A.sumsq[a] / n - mean * mean) * (n / (n - 1))) : 0;
  const dm = n ? A.diff[a] / n : 0;
  const dsd = n > 1 ? Math.sqrt(Math.max(0, A.diffsq[a] / n - dm * dm) * (n / (n - 1))) : 0;
  const coins = sleeves.filter((e) => e[a] !== 1);
  const port = sleeves.length ? sleeves.reduce((acc, e) => acc + e[a], 0) / coinsInSplit[sp] - 1 : 0;
  return {
    n,
    mean: mean * 100,
    win: n ? (A.wins[a] / n) * 100 : 0,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    worst: A.worst[a] * 100,
    ctrl: n ? (A.ctrl[a] / n) * 100 : 0,
    edge: dm * 100,
    edgeT: dsd > 0 ? dm / (dsd / Math.sqrt(n)) : 0,
    holdDays: n ? (A.hold[a] / n) * (BAR_MIN / 1440) : 0,
    portfolio: port * 100,
    coinsProfitable: coins.length ? coins.filter((e) => e[a] > 1).length / coins.length : 0,
  };
};
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const all = VARIANTS.map((v, vi) => ({ v, vi, A: stat(vi, 0), B: stat(vi, 1) }));
const bh = (sp) => (holdReturns[sp].reduce((a, b) => a + b, 0) / holdReturns[sp].length) * 100;
const splitDay = new Date(SPLIT).toISOString().slice(0, 10);

console.log(`\n${'='.repeat(78)}\nKẾT QUẢ: ${used.length} coin · ${V} biến thể · phí 0.1%/chiều · nến 5 phút`);
console.log(`Giai đoạn A (tìm kiếm): đến ${splitDay} · giữ coin trung bình ${f(bh(0), 0)}%`);
console.log(`Giai đoạn B (kiểm tra): từ ${splitDay} · giữ coin trung bình ${f(bh(1), 0)}%\n${'='.repeat(78)}`);

const pos = (sp, key) => all.filter((x) => (sp ? x.B : x.A)[key] > 0 && (sp ? x.B : x.A).n >= 30).length;
console.log(`\n1) Lãi trung bình mỗi lệnh > 0 (sau phí):   A ${pos(0, 'mean')}/${V} biến thể · B ${pos(1, 'mean')}/${V}`);
console.log(`2) Thắng được lệnh mua NGẪU NHIÊN cùng cách thoát: A ${pos(0, 'edge')}/${V} · B ${pos(1, 'edge')}/${V}`);
const sig = (sp) => all.filter((x) => (sp ? x.B : x.A).edgeT >= 3).length;
console.log(`3) Thắng ngẫu nhiên có ý nghĩa thống kê (t ≥ 3): A ${sig(0)}/${V} · B ${sig(1)}/${V}`);
const both = all.filter((x) => x.A.edgeT >= 3 && x.B.edgeT >= 3);
console.log(`4) Có ý nghĩa ở CẢ HAI giai đoạn: ${both.length}/${V}`);
{
  const xs = all.filter((x) => x.A.n >= 30 && x.B.n >= 30);
  const ma = xs.reduce((a, x) => a + x.A.edge, 0) / xs.length;
  const mb = xs.reduce((a, x) => a + x.B.edge, 0) / xs.length;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  xs.forEach((x) => {
    sab += (x.A.edge - ma) * (x.B.edge - mb);
    saa += (x.A.edge - ma) ** 2;
    sbb += (x.B.edge - mb) ** 2;
  });
  console.log(`5) Tương quan "lợi thế ở A" với "lợi thế ở B" giữa các biến thể: ${f(sab / Math.sqrt(saa * sbb))} (gần 1 = quá khứ dự báo được tương lai, gần 0 = không)`);
}

const row = (x) =>
  `   A: ${String(x.A.n).padStart(5)} lệnh · TB ${f(x.A.mean).padStart(6)}%/lệnh · thắng ${f(x.A.win, 0)}% · ngẫu nhiên ${f(x.A.ctrl).padStart(6)}% · lợi thế ${f(x.A.edge).padStart(6)}% (t=${f(x.A.edgeT, 1)}) · danh mục ${f(x.A.portfolio, 0)}%\n` +
  `   B: ${String(x.B.n).padStart(5)} lệnh · TB ${f(x.B.mean).padStart(6)}%/lệnh · thắng ${f(x.B.win, 0)}% · ngẫu nhiên ${f(x.B.ctrl).padStart(6)}% · lợi thế ${f(x.B.edge).padStart(6)}% (t=${f(x.B.edgeT, 1)}) · danh mục ${f(x.B.portfolio, 0)}% · lệnh tệ nhất ${f(x.B.worst, 0)}%`;
const show = (title, list) => {
  console.log(`\n${title}`);
  list.forEach((x, k) => console.log(` #${k + 1} ${label(x.v)}\n${row(x)}`));
};
const eligible = all.filter((x) => x.A.n >= 200);
show('6) 5 biến thể LÃI NHIỀU NHẤT ở A (≥200 lệnh) → kết quả ở B:', [...eligible].sort((a, b) => b.A.portfolio - a.A.portfolio).slice(0, 5));
show('7) 5 biến thể có LỢI THẾ so với ngẫu nhiên mạnh nhất ở A → kết quả ở B:', [...eligible].sort((a, b) => b.A.edgeT - a.A.edgeT).slice(0, 5));
show('8) 5 biến thể có tỷ lệ THẮNG cao nhất ở A → kết quả ở B:', [...eligible].sort((a, b) => b.A.win - a.A.win).slice(0, 5));
const pepe = all.find((x) => x.v.d === 0.05 && x.v.l === 12 && x.v.t === 0.03 && x.v.s === 0 && x.v.h === H[2]);
show('9) Luật từ thử nghiệm PEPE (giảm 5% trong 1h, chốt +3%, không cắt lỗ):', [pepe]);
console.log('   theo năm (lãi TB/lệnh): ' + YEARS.map((y, k) => {
  const n = A.yearN[pepe.vi * YEARS.length + k];
  return `${y}: ${n ? f((A.yearSum[pepe.vi * YEARS.length + k] / n) * 100) + '%' : '—'} (${n})`;
}).join(' · '));
if (both.length) show('10) Biến thể thắng ngẫu nhiên có ý nghĩa ở CẢ HAI giai đoạn:', both.sort((a, b) => b.B.edgeT - a.B.edgeT).slice(0, 10));

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), coins: used, split: splitDay, buyHold: { A: bh(0), B: bh(1) }, variants: all.map((x) => ({ rule: label(x.v), ...x.v, A: x.A, B: x.B })) }, null, 1));
console.log(`\nĐã lưu: ${OUT} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
