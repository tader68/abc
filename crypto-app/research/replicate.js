#!/usr/bin/env node
// Replication of published crypto anomalies on Binance data, with costs and a split into the
// papers' own era and the years after publication (genuinely out-of-sample for the authors):
//   1. Bitcoin hour-of-day seasonality (Padyšák & Vojtko 2022: 21:00–23:00 UTC)
//   2. short-horizon mean reversion in BTC (negative autocorrelation of 1–4h returns)
//   3. MAX effect: coins with an extreme up-day last week (low MAX beats high MAX)
//   4. 3-week cross-sectional momentum (Liu, Tsyvinski & Wu 2022)
//
//   node research/replicate.js [--out replicate-results.json]
import { writeFileSync } from 'node:fs';
import { fetchSpotHistory, loadSpotHistoryCached } from './data.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';
import { tStat } from './stats.js';

const args = parseArgs(process.argv.slice(2));
const OUT = args.out || 'replicate-results.json';
const H = 3_600_000;
const DAY = 86_400_000;
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const year = (t) => new Date(t).getUTCFullYear();
const out = {};

const summary = (rets, periodsPerYear) => {
  const eq = rets.reduce((a, r) => a * (1 + r), 1);
  let peak = 1;
  let e = 1;
  let mdd = 0;
  for (const r of rets) {
    e *= 1 + r;
    peak = Math.max(peak, e);
    mdd = Math.max(mdd, 1 - e / peak);
  }
  return { n: rets.length, cagr: (eq ** (periodsPerYear / Math.max(1, rets.length)) - 1) * 100, maxDD: mdd * 100, t: tStat(rets) };
};
const line = (s) => `${f(s.cagr).padStart(6)}%/năm · sụt ${f(s.maxDD, 0).padStart(3)}% · t=${f(s.t)}`;

// ---------- 1 & 2: BTC hourly ----------
log('Tải BTC nến 1 giờ từ 2018...');
const btc = await fetchSpotHistory('BTCUSDT', '1h', Date.UTC(2018, 0, 1));
const n = btc.t.length;
const r1 = Array.from({ length: n }, (_, i) => (i ? btc.c[i] / btc.c[i - 1] - 1 : 0));
const ERAS = [['2018–2021 (thời kỳ của bài báo)', 2018, 2021], ['2022–2023', 2022, 2023], ['2024–nay', 2024, 2026]];

log('\n1) LỢI NHUẬN TRUNG BÌNH CỦA BTC THEO GIỜ (UTC) — bps mỗi giờ (1 bps = 0.01%)');
const hourly = {};
for (const [name, y0, y1] of ERAS) {
  const sums = new Array(24).fill(0);
  const cnt = new Array(24).fill(0);
  for (let i = 1; i < n; i++) {
    const y = year(btc.t[i]);
    if (y < y0 || y > y1) continue;
    const h = new Date(btc.t[i]).getUTCHours(); // candle opening at h: return over hour h
    sums[h] += r1[i];
    cnt[h]++;
  }
  hourly[name] = sums.map((s, h) => (s / cnt[h]) * 1e4);
}
log('   giờ  ' + ERAS.map(([nm]) => nm.slice(0, 9).padStart(11)).join(''));
for (let h = 0; h < 24; h++) log(`   ${String(h).padStart(2)}h ` + ERAS.map(([nm]) => f(hourly[nm][h], 1).padStart(11)).join('') + (h >= 21 && h <= 22 ? '   ← khung giờ bài báo' : ''));

// strategy: hold BTC during the 21:00 and 22:00 UTC candles only
log('\n   Chiến lược: chỉ giữ BTC từ 21:00 đến 23:00 UTC mỗi ngày');
for (const cost of [0, 0.001, 0.002]) {
  for (const [name, y0, y1] of ERAS) {
    const daily = [];
    for (let i = 1; i < n; i++) {
      const d = new Date(btc.t[i]);
      if (d.getUTCHours() !== 21 || year(btc.t[i]) < y0 || year(btc.t[i]) > y1 || i + 1 >= n) continue;
      daily.push((1 + r1[i]) * (1 + r1[i + 1]) * (1 - cost) - 1);
    }
    const s = summary(daily, 365);
    out[`hour_${cost}_${y0}`] = s;
    log(`   phí ${f(cost * 100, 1)}%/vòng · ${name.padEnd(30)} ${line(s)}`);
  }
}

log('\n2) ĐẢO CHIỀU NGẮN HẠN: tự tương quan lợi nhuận BTC (âm = hay đảo chiều)');
for (const k of [1, 2, 4]) {
  const row = ERAS.map(([, y0, y1]) => {
    const xs = [];
    for (let i = 2 * k; i < n; i += k) {
      const y = year(btc.t[i]);
      if (y < y0 || y > y1) continue;
      xs.push([btc.c[i - k] / btc.c[i - 2 * k] - 1, btc.c[i] / btc.c[i - k] - 1]);
    }
    const ma = xs.reduce((a, x) => a + x[0], 0) / xs.length;
    const mb = xs.reduce((a, x) => a + x[1], 0) / xs.length;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (const [a, b] of xs) {
      sab += (a - ma) * (b - mb);
      saa += (a - ma) ** 2;
      sbb += (b - mb) ** 2;
    }
    return sab / Math.sqrt(saa * sbb);
  });
  log(`   nến ${k}h: ` + ERAS.map(([nm], j) => `${nm.slice(0, 9)} ${f(row[j], 3)}`).join(' · '));
}
log('   Chiến lược: sau nhịp 4h vượt ±X% thì đánh ngược trong 4h tiếp theo (futures, phí 0.1%/vòng)');
for (const thr of [0.01, 0.02, 0.03]) {
  for (const [name, y0, y1] of ERAS) {
    const rets = [];
    for (let i = 8; i + 4 < n; i += 4) {
      const y = year(btc.t[i]);
      if (y < y0 || y > y1) continue;
      const past = btc.c[i] / btc.c[i - 4] - 1;
      if (Math.abs(past) < thr) continue;
      const next = btc.c[i + 4] / btc.c[i] - 1;
      rets.push(-Math.sign(past) * next - 0.001);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
    log(`   ngưỡng ±${thr * 100}% · ${name.padEnd(30)} ${String(rets.length).padStart(4)} lệnh · lãi TB ${f(mean * 100, 2)}%/lệnh · t=${f(tStat(rets))}`);
  }
}

// ---------- 3 & 4: cross-section of coins (daily, incl. dead coins) ----------
const DEAD = ['LUNAUSDT', 'FTTUSDT', 'SRMUSDT', 'ANCUSDT', 'MIRUSDT', 'WAVESUSDT', 'OMGUSDT', 'BTCSTUSDT', 'SXPUSDT', 'MATICUSDT', 'FTMUSDT', 'EOSUSDT', 'MKRUSDT', 'OCEANUSDT', 'AGIXUSDT', 'KLAYUSDT', 'BALUSDT'];
const MEMES = ['PEPEUSDT', 'SHIBUSDT', 'FLOKIUSDT', 'BONKUSDT', 'WIFUSDT'];
const UNIVERSE = [...DEFAULT_UNIVERSE, ...MEMES, ...DEAD];
log(`\nTải ${UNIVERSE.length} coin (kể cả coin đã chết) và gộp thành nến ngày...`);
const FROM = Date.parse('2021-01-01T00:00:00Z');
const days = new Map(); // day -> Map(symbol -> {c, h})
for (const sym of UNIVERSE) {
  const s = await loadSpotHistoryCached(sym, '5m', FROM);
  let cur = -1;
  let hi = 0;
  let last = 0;
  const flush = () => {
    if (cur < 0) return;
    if (!days.has(cur)) days.set(cur, new Map());
    days.get(cur).set(sym, { c: last, h: hi });
  };
  for (let i = 0; i < s.t.length; i++) {
    const d = Math.floor(s.t[i] / DAY);
    if (d !== cur) {
      flush();
      cur = d;
      hi = 0;
    }
    hi = Math.max(hi, s.h[i]);
    last = s.c[i];
  }
  flush();
}
const dayList = [...days.keys()].sort((a, b) => a - b);
const close = (d, s) => days.get(d)?.get(s)?.c;
// weekly rebalance (every 7 days): rank, long top / short bottom quintile, equal weight, 0.2% per unit turnover
const weekly = (signal, label) => {
  const res = { A: [], B: [] };
  let prev = new Map();
  for (let k = 28; k + 7 < dayList.length; k += 7) {
    const d = dayList[k];
    const dNext = dayList[k + 7];
    const cand = [];
    for (const sym of UNIVERSE) {
      const s = signal(sym, k);
      const p0 = close(d, sym);
      const p1 = close(dNext, sym) ?? (days.get(dayList[k + 1])?.has(sym) ? undefined : null);
      if (!Number.isFinite(s) || !p0) continue;
      // a coin delisted during the week counts at -100% only if it vanished; otherwise skip missing data
      const r = p1 ? p1 / p0 - 1 : p1 === null ? -0.9 : NaN;
      if (Number.isFinite(r)) cand.push({ sym, s, r });
    }
    if (cand.length < 15) continue;
    cand.sort((a, b) => b.s - a.s);
    const q = Math.floor(cand.length / 5);
    const top = cand.slice(0, q);
    const bot = cand.slice(-q);
    const w = new Map();
    top.forEach((x) => w.set(x.sym, 0.5 / q));
    bot.forEach((x) => w.set(x.sym, -0.5 / q));
    let turn = 0;
    for (const sym of new Set([...w.keys(), ...prev.keys()])) turn += Math.abs((w.get(sym) || 0) - (prev.get(sym) || 0));
    prev = w;
    const mean = (xs) => xs.reduce((a, x) => a + x.r, 0) / xs.length;
    const r = 0.5 * mean(top) - 0.5 * mean(bot) - turn * 0.002;
    (d * DAY < Date.parse('2024-01-01') ? res.A : res.B).push({ r, gross: 0.5 * mean(top) - 0.5 * mean(bot) });
  }
  const A = summary(res.A.map((x) => x.r), 52);
  const B = summary(res.B.map((x) => x.r), 52);
  const gA = summary(res.A.map((x) => x.gross), 52);
  const gB = summary(res.B.map((x) => x.gross), 52);
  out[label] = { A, B, gA, gB };
  log(`   ${label}\n     2021–2023: trước phí ${line(gA)} | sau phí ${line(A)}\n     2024–nay : trước phí ${line(gB)} | sau phí ${line(B)}`);
};
const ret = (sym, k, back) => {
  const a = close(dayList[k], sym);
  const b = close(dayList[k - back], sym);
  return a && b ? a / b - 1 : NaN;
};
const maxDaily = (sym, k) => {
  let m = -Infinity;
  for (let j = k - 6; j <= k; j++) {
    const a = close(dayList[j], sym);
    const b = close(dayList[j - 1], sym);
    if (!a || !b) return NaN;
    m = Math.max(m, a / b - 1);
  }
  return m;
};
log('\n3) HIỆU ỨNG MAX (mỗi tuần: long 1/5 số coin có ngày tăng mạnh nhất THẤP nhất, short 1/5 cao nhất)');
weekly((sym, k) => -maxDaily(sym, k), 'MAX thấp − MAX cao');
weekly((sym, k) => maxDaily(sym, k), 'MAX cao − MAX thấp ("MAX momentum")');
log('\n4) MOMENTUM (mỗi tuần: long 1/5 coin tăng mạnh nhất, short 1/5 yếu nhất)');
weekly((sym, k) => ret(sym, k, 21), 'Momentum 3 tuần');
weekly((sym, k) => ret(sym, k, 7), 'Momentum 1 tuần');
weekly((sym, k) => -ret(sym, k, 7), 'Đảo chiều 1 tuần');

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), hourly, results: out }, null, 1));
log(`\nĐã lưu: ${OUT}`);
