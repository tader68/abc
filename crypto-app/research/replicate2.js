#!/usr/bin/env node
// Replication, part 2 — more published ideas, tested with costs and split by period:
//   1. pairs trading / statistical arbitrage on cointegrated coins (hourly)
//   2. Bitcoin → altcoin lead-lag at 5 minutes
//   3. day-of-week effects in BTC / ETH
//   4. on-chain valuation (MVRV, CoinMetrics community data) to time BTC
//
//   node research/replicate2.js [--out replicate2-results.json]
import { writeFileSync } from 'node:fs';
import { loadSpotHistoryCached, fetchSpotHistory } from './data.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';
import { tStat } from './stats.js';

const args = parseArgs(process.argv.slice(2));
const OUT = args.out || 'replicate2-results.json';
const DAY = 86_400_000;
const H = 3_600_000;
const SPLIT = Date.parse('2024-01-01T00:00:00Z');
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const out = {};
const tradeLine = (rs) => {
  const m = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
  const comp = (rs.reduce((a, r) => a * (1 + r), 1) - 1) * 100;
  return `${String(rs.length).padStart(5)} lệnh · TB ${f(m * 100, 2).padStart(6)}%/lệnh · thắng ${f((rs.filter((r) => r > 0).length / Math.max(1, rs.length)) * 100, 0)}% · t=${f(tStat(rs))} · cộng dồn ${f(comp, 0)}%`;
};

// ---------- load hourly closes from the 5m cache ----------
const DEAD = ['LUNAUSDT', 'FTTUSDT', 'SRMUSDT', 'WAVESUSDT', 'OMGUSDT', 'SXPUSDT', 'MATICUSDT', 'FTMUSDT', 'EOSUSDT', 'MKRUSDT', 'OCEANUSDT', 'AGIXUSDT', 'KLAYUSDT', 'BALUSDT'];
const UNIVERSE = [...DEFAULT_UNIVERSE, ...DEAD];
const FROM = Date.parse('2021-01-01T00:00:00Z');
log(`Tải ${UNIVERSE.length} coin (nến 5 phút, gộp thành nến 1 giờ)...`);
const raw = {};
const hourly = {};
for (const sym of UNIVERSE) {
  const s = await loadSpotHistoryCached(sym, '5m', FROM);
  raw[sym] = s;
  const m = new Map();
  for (let i = 0; i < s.t.length; i++) if ((s.t[i] + 300_000) % H === 0) m.set(s.t[i] + 300_000, s.c[i]); // close of each hour
  hourly[sym] = m;
}
const hours = [];
for (let t = FROM + H; t < Date.now() - H; t += H) hours.push(t);

// ---------- 1. pairs trading ----------
log('\n1) PAIRS TRADING — mỗi tuần: chọn 10 cặp coin có độ lệch hồi quy nhanh nhất trong 30 ngày trước, giao dịch 7 ngày sau');
log('   Vào lệnh khi độ lệch vượt ±2 độ lệch chuẩn (mua coin rẻ, bán coin đắt), thoát khi về 0, cắt lỗ ở ±4, đóng hết cuối tuần. Phí 4 chiều 0.28%/vòng.');
const FORM = 30 * 24;
const TRADE = 7 * 24;
const COST_PAIR = 4 * (0.0005 + 0.0002);
const pairTrades = { A: [], B: [] };
const syms = UNIVERSE;
for (let start = FORM; start + TRADE < hours.length; start += TRADE) {
  const formH = hours.slice(start - FORM, start);
  const series = {};
  for (const s of syms) {
    const xs = formH.map((t) => hourly[s].get(t));
    if (xs.every((x) => x > 0)) series[s] = xs.map(Math.log);
  }
  const names = Object.keys(series);
  const cands = [];
  for (let a = 0; a < names.length; a++)
    for (let b = a + 1; b < names.length; b++) {
      const x = series[names[a]];
      const y = series[names[b]];
      // hedge ratio by OLS y = alpha + beta x, spread = y - beta x
      let mx = 0;
      let my = 0;
      for (let i = 0; i < x.length; i++) {
        mx += x[i];
        my += y[i];
      }
      mx /= x.length;
      my /= y.length;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < x.length; i++) {
        sxy += (x[i] - mx) * (y[i] - my);
        sxx += (x[i] - mx) ** 2;
      }
      const beta = sxy / sxx;
      if (!(beta > 0.2 && beta < 5)) continue;
      const sp = y.map((v, i) => v - beta * x[i]);
      const m = sp.reduce((p, q) => p + q, 0) / sp.length;
      const sd = Math.sqrt(sp.reduce((p, q) => p + (q - m) ** 2, 0) / sp.length);
      // mean-reversion speed: AR(1) on the spread → half-life in hours
      let num = 0;
      let den = 0;
      for (let i = 1; i < sp.length; i++) {
        num += (sp[i - 1] - m) * (sp[i] - m);
        den += (sp[i - 1] - m) ** 2;
      }
      const phi = num / den;
      if (!(phi > 0 && phi < 1)) continue;
      const half = Math.log(0.5) / Math.log(phi);
      if (half < 2 || half > 72) continue;
      cands.push({ a: names[a], b: names[b], beta, m, sd, half });
    }
  cands.sort((p, q) => p.half - q.half);
  const used = new Set();
  const chosen = [];
  for (const c of cands) {
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a);
    used.add(c.b);
    chosen.push(c);
    if (chosen.length >= 10) break;
  }
  const tradeH = hours.slice(start, start + TRADE);
  for (const c of chosen) {
    let pos = 0;
    let entry = null;
    for (let k = 0; k < tradeH.length; k++) {
      const pa = hourly[c.a].get(tradeH[k]);
      const pb = hourly[c.b].get(tradeH[k]);
      if (!(pa > 0 && pb > 0)) continue;
      const z = (Math.log(pb) - c.beta * Math.log(pa) - c.m) / c.sd;
      const last = k === tradeH.length - 1;
      if (pos === 0 && Math.abs(z) > 2 && !last) {
        pos = z > 0 ? -1 : 1; // z>0: B rich → short B, long A
        entry = { pa, pb };
      } else if (pos !== 0 && (pos * z >= 0 || Math.abs(z) > 4 || last)) {
        // P&L of a dollar-neutral position: pos * (ret_B - ret_A) with weights 1/(1+beta), beta/(1+beta)
        const rb = pb / entry.pb - 1;
        const ra = pa / entry.pa - 1;
        const wB = 1 / (1 + c.beta);
        const wA = c.beta / (1 + c.beta);
        const r = pos * (wB * rb - wA * ra) - COST_PAIR / 2;
        (tradeH[k] < SPLIT ? pairTrades.A : pairTrades.B).push(r);
        pos = 0;
      }
    }
  }
}
log(`   2021–2023: ${tradeLine(pairTrades.A)}`);
log(`   2024–nay : ${tradeLine(pairTrades.B)}`);
out.pairs = { A: pairTrades.A.length, B: pairTrades.B.length };

// ---------- 2. BTC → altcoin lead-lag (5m) ----------
log('\n2) BTC DẪN TRƯỚC ALTCOIN (nến 5 phút): khi BTC chạy ≥X% trong 5 phút mà altcoin mới chạy chưa tới một nửa,');
log('   vào lệnh cùng chiều với BTC trên altcoin ở giá mở nến kế tiếp, giữ 15 phút. Phí futures 0.14%/vòng.');
const btc = raw.BTCUSDT;
const btcIdx = new Map([...btc.t].map((t, i) => [t, i]));
const ALTS = UNIVERSE.filter((s) => !['BTCUSDT', 'ETHUSDT'].includes(s));
for (const thr of [0.005, 0.01]) {
  const res = { A: [], B: [] };
  for (const sym of ALTS) {
    const s = raw[sym];
    for (let i = 1; i + 3 < s.t.length; i++) {
      const j = btcIdx.get(s.t[i]);
      if (j === undefined || j < 1) continue;
      const rb = btc.c[j] / btc.c[j - 1] - 1;
      if (Math.abs(rb) < thr) continue;
      const ra = s.c[i] / s.c[i - 1] - 1;
      if (Math.sign(ra) === Math.sign(rb) && Math.abs(ra) >= Math.abs(rb) / 2) continue;
      if (s.t[i + 3] - s.t[i] !== 15 * 60_000) continue;
      const r = Math.sign(rb) * (s.c[i + 3] / s.o[i + 1] - 1) - 0.0014;
      (s.t[i] < SPLIT ? res.A : res.B).push(r);
    }
  }
  log(`   BTC chạy ≥${thr * 100}%: 2021–2023 ${tradeLine(res.A)}`);
  log(`   ${' '.repeat(16)}2024–nay  ${tradeLine(res.B)}`);
}

// ---------- 3. day of week ----------
log('\n3) NGÀY TRONG TUẦN — lợi nhuận trung bình mỗi ngày (UTC) của BTC / ETH');
const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
for (const sym of ['BTCUSDT', 'ETHUSDT']) {
  const d = await fetchSpotHistory(sym, '1d', Date.UTC(2018, 0, 1));
  for (const [name, y0, y1] of [['2018–2023', 2018, 2023], ['2024–nay ', 2024, 2026]]) {
    const sums = new Array(7).fill(0);
    const cnt = new Array(7).fill(0);
    const all = new Array(7).fill(null).map(() => []);
    for (let i = 0; i < d.t.length; i++) {
      const dt = new Date(d.t[i]);
      if (dt.getUTCFullYear() < y0 || dt.getUTCFullYear() > y1) continue;
      const r = d.c[i] / d.o[i] - 1;
      sums[dt.getUTCDay()] += r;
      cnt[dt.getUTCDay()]++;
      all[dt.getUTCDay()].push(r);
    }
    log(`   ${sym.replace('USDT', '')} ${name}: ` + DOW.map((nm, k) => `${nm} ${f((sums[k] / cnt[k]) * 100, 2)}% (t=${f(tStat(all[k]), 1)})`).join(' · '));
  }
}

// ---------- 4. MVRV ----------
log('\n4) ON-CHAIN MVRV (giá thị trường / giá vốn trung bình của mọi người giữ BTC) để canh mua/bán BTC');
let url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur,PriceUSD&frequency=1d&paging_from=start&page_size=10000';
const rows = [];
while (url) {
  const j = await (await fetch(url)).json();
  rows.push(...j.data);
  url = j.next_page_url;
}
const mv = rows.filter((r) => r.CapMVRVCur && r.PriceUSD).map((r) => ({ t: Date.parse(r.time), m: +r.CapMVRVCur, p: +r.PriceUSD }));
log(`   ${mv.length} ngày dữ liệu (${new Date(mv[0].t).toISOString().slice(0, 10)} → ${new Date(mv[mv.length - 1].t).toISOString().slice(0, 10)})`);
const runMvrv = (buy, sell, from, to) => {
  let inv = false;
  let eq = 1;
  let bh = 1;
  let peak = 1;
  let mdd = 0;
  let trades = 0;
  for (let i = 1; i < mv.length; i++) {
    if (mv[i].t < from || mv[i].t >= to) continue;
    const r = mv[i].p / mv[i - 1].p - 1;
    if (inv) eq *= 1 + r;
    bh *= 1 + r;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, 1 - eq / peak);
    // decide at today's close for tomorrow
    if (!inv && mv[i].m < buy) {
      inv = true;
      trades++;
      eq *= 0.999;
    } else if (inv && mv[i].m > sell) {
      inv = false;
      eq *= 0.999;
    }
  }
  const yrs = (Math.min(to, mv[mv.length - 1].t) - Math.max(from, mv[0].t)) / (365 * DAY);
  return { cagr: (eq ** (1 / yrs) - 1) * 100, bh: (bh ** (1 / yrs) - 1) * 100, mdd: mdd * 100, trades };
};
const A0 = Date.parse('2013-01-01');
const B0 = Date.parse('2021-01-01');
const grid = [];
for (const buy of [0.9, 1.0, 1.2, 1.5, 2.0]) for (const sell of [2.5, 3.0, 3.5, 4.0]) if (sell > buy) grid.push({ buy, sell, A: runMvrv(buy, sell, A0, B0), B: runMvrv(buy, sell, B0, Infinity) });
const bhA = grid[0].A.bh;
const bhB = grid[0].B.bh;
log(`   Giữ BTC luôn: 2013–2020 ${f(bhA)}%/năm · 2021–nay ${f(bhB)}%/năm`);
for (const g of [...grid].sort((a, b) => b.A.cagr - a.A.cagr).slice(0, 5))
  log(`   mua khi MVRV < ${g.buy}, bán khi > ${g.sell}: 2013–2020 ${f(g.A.cagr)}%/năm (sụt ${f(g.A.mdd, 0)}%, ${g.A.trades} lần mua) · 2021–nay ${f(g.B.cagr)}%/năm (sụt ${f(g.B.mdd, 0)}%, ${g.B.trades} lần mua)`);
log(`   MVRV hiện tại: ${f(mv[mv.length - 1].m, 2)}`);

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), out, mvrvGrid: grid }, null, 1));
log(`\nĐã lưu: ${OUT}`);
