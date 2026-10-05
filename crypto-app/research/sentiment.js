#!/usr/bin/env node
// Study 1 — market timing with sentiment and liquidity (daily):
//   - Crypto Fear & Greed index (alternative.me, since 2018-02)
//   - total stablecoin supply (DefiLlama): money flowing into / out of crypto
// Assets: BTC, ETH and an equal-weight altcoin index. Decisions at the daily close, executed at the
// next day's open (no look-ahead), 0.1% per switch. Search period → untouched test period.
//
//   node research/sentiment.js [--split 2023-01] [--out sentiment-results.json]
import { writeFileSync } from 'node:fs';
import { fetchSpotHistory } from './data.js';
import { parseArgs, DEFAULT_UNIVERSE } from './common.js';

const args = parseArgs(process.argv.slice(2));
const SPLIT = Date.parse(`${args.split || '2023-01'}-01T00:00:00Z`);
const OUT = args.out || 'sentiment-results.json';
const DAY = 86_400_000;
const COST = 0.001;
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const dayKey = (t) => Math.floor(t / DAY);

// ---------- data ----------
const getJson = async (url) => {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 2000 * (k + 1)));
  }
  throw new Error(`không tải được ${url}`);
};
log('Tải Fear & Greed, stablecoin và giá...');
const fng = new Map((await getJson('https://api.alternative.me/fng/?limit=0&format=json')).data.map((x) => [dayKey(+x.timestamp * 1000), +x.value]));
const stable = new Map((await getJson('https://stablecoins.llama.fi/stablecoincharts/all')).map((x) => [dayKey(+x.date * 1000), x.totalCirculatingUSD.peggedUSD || 0]));

const FROM = Date.UTC(2018, 1, 1);
const prices = {};
for (const sym of DEFAULT_UNIVERSE) {
  try {
    const s = await fetchSpotHistory(sym, '1d', FROM);
    prices[sym] = new Map([...s.t].map((t, i) => [dayKey(t), { o: s.o[i], c: s.c[i] }]));
  } catch {
    /* coin unavailable */
  }
}
const days = [...prices.BTCUSDT.keys()].filter((d) => fng.has(d) && stable.has(d)).sort((a, b) => a - b);
const n = days.length;
const T = days.map((d) => d * DAY);
// daily open→open returns (a decision at close of day i is executed at open of day i+1)
const assetReturns = (sym) => {
  const p = prices[sym];
  return days.map((d, i) => (i + 1 < n && p.has(d) && p.has(days[i + 1]) ? p.get(days[i + 1]).o / p.get(d).o - 1 : NaN));
};
const R = { BTC: assetReturns('BTCUSDT'), ETH: assetReturns('ETHUSDT') };
const alts = DEFAULT_UNIVERSE.filter((s) => !['BTCUSDT', 'ETHUSDT'].includes(s) && prices[s]).map(assetReturns);
R.ALT = days.map((_, i) => {
  const xs = alts.map((r) => r[i]).filter(Number.isFinite);
  return xs.length >= 5 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
});
const FG = days.map((d) => fng.get(d));
const ST = days.map((d) => stable.get(d));
const btcClose = days.map((d) => prices.BTCUSDT.get(d).c);
log(`${n} ngày (${new Date(T[0]).toISOString().slice(0, 10)} → ${new Date(T[n - 1]).toISOString().slice(0, 10)}), ${alts.length} altcoin trong chỉ số\n`);

// ---------- 1. forward returns by sentiment bucket ----------
const fwd = (r, i, h) => {
  let g = 1;
  for (let k = i + 1; k <= i + h && k < n; k++) {
    if (!Number.isFinite(r[k - 1])) return NaN;
    g *= 1 + r[k - 1];
  }
  return i + h < n ? g - 1 : NaN;
};
const buckets = [[0, 15, 'Sợ hãi tột độ (0–15)'], [15, 30, 'Sợ hãi (15–30)'], [30, 45, 'Hơi sợ (30–45)'], [45, 55, 'Trung lập (45–55)'], [55, 70, 'Hơi tham (55–70)'], [70, 85, 'Tham lam (70–85)'], [85, 101, 'Tham lam tột độ (85–100)']];
const H = 30;
log(`1) Lợi nhuận ${H} ngày SAU KHI chỉ số Fear & Greed ở từng mức (toàn bộ ${new Date(T[0]).getUTCFullYear()}–nay):`);
for (const asset of ['BTC', 'ALT']) {
  const all = T.map((_, i) => fwd(R[asset], i, H)).filter(Number.isFinite);
  const base = all.reduce((a, b) => a + b, 0) / all.length;
  log(`   ${asset}: trung bình mọi ngày ${f(base * 100)}%`);
  for (const [lo, hi, name] of buckets) {
    const xs = T.map((_, i) => (FG[i] >= lo && FG[i] < hi ? fwd(R[asset], i, H) : NaN)).filter(Number.isFinite);
    if (xs.length < 20) continue;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    const nEff = Math.max(2, xs.length / H); // overlapping windows → conservative effective sample size
    const t = (m - base) / (sd / Math.sqrt(nEff));
    log(`     ${name.padEnd(26)} ${String(xs.length).padStart(4)} ngày · TB ${f(m * 100).padStart(6)}% · lãi ${f((xs.filter((x) => x > 0).length / xs.length) * 100, 0)}% số lần · chênh so với TB ${f((m - base) * 100).padStart(6)}% (t≈${f(t)})`);
  }
}

// ---------- 2. timing strategies ----------
// signal(i) → true = invested during day i+1
const backtest = (r, sig, from, to) => {
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  let inv = false;
  let daysIn = 0;
  let switches = 0;
  let bh = 1;
  let bhPeak = 1;
  let bhDD = 0;
  for (let i = from; i < to - 2; i++) {
    const want = sig(i); // known at the close of day i
    if (want !== inv) {
      eq *= 1 - COST;
      switches++;
      inv = want;
    }
    // r[i + 1] = open of day i+1 → open of day i+2: the first return that can be traded on the signal
    const x = Number.isFinite(r[i + 1]) ? r[i + 1] : 0;
    if (inv) {
      eq *= 1 + x;
      daysIn++;
    }
    bh *= 1 + x;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, 1 - eq / peak);
    bhPeak = Math.max(bhPeak, bh);
    bhDD = Math.max(bhDD, 1 - bh / bhPeak);
  }
  const yrs = (T[to - 1] - T[from]) / (365 * DAY);
  return { cagr: (eq ** (1 / yrs) - 1) * 100, maxDD: mdd * 100, inMarket: (daysIn / (to - 2 - from)) * 100, switches, bhCagr: (bh ** (1 / yrs) - 1) * 100, bhDD: bhDD * 100, calmar: (eq ** (1 / yrs) - 1) / Math.max(mdd, 0.05) };
};
const sma = (v, p) => v.map((_, i) => (i >= p - 1 ? v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p : NaN));
const btc200 = sma(btcClose, 200);
const growth = (lb) => ST.map((x, i) => (i >= lb && ST[i - lb] > 0 ? x / ST[i - lb] - 1 : NaN));
const G = { 14: growth(14), 30: growth(30), 60: growth(60), 90: growth(90) };

const strategies = [];
// buy fear / sell greed with hysteresis
for (const lo of [10, 20, 25, 30, 40])
  for (const hi of [50, 60, 70, 75, 80, 90]) {
    if (hi <= lo) continue;
    const make = () => {
      let state = false;
      let last = -1;
      return (i) => {
        if (i !== last + 1) state = false; // fresh run
        last = i;
        if (FG[i] <= lo) state = true;
        else if (FG[i] >= hi) state = false;
        return state;
      };
    };
    strategies.push({ name: `Mua khi F&G ≤ ${lo}, bán khi ≥ ${hi}`, group: 'fear', make });
  }
// stablecoin liquidity regime
for (const lb of [14, 30, 60, 90])
  for (const g of [0, 0.01, 0.02, 0.03]) strategies.push({ name: `Giữ khi tổng stablecoin ${lb} ngày tăng > ${g * 100}%`, group: 'liquidity', make: () => (i) => G[lb][i] > g });
// trend baseline and combinations
strategies.push({ name: 'Giữ khi BTC > SMA200 (đối chứng xu hướng)', group: 'trend', make: () => (i) => btcClose[i] > btc200[i] });
for (const lb of [30, 60])
  strategies.push({ name: `Giữ khi BTC > SMA200 VÀ stablecoin ${lb} ngày tăng`, group: 'combo', make: () => (i) => btcClose[i] > btc200[i] && G[lb][i] > 0 });
for (const lb of [30, 60])
  strategies.push({ name: `Giữ khi stablecoin ${lb} ngày tăng HOẶC F&G ≤ 20`, group: 'combo', make: () => (i) => G[lb][i] > 0 || FG[i] <= 20 });

const split = T.findIndex((t) => t >= SPLIT);
const START = 200;
log(`\n2) Chiến lược canh thời điểm — tìm trên ${new Date(T[START]).toISOString().slice(0, 10)}→${new Date(SPLIT).toISOString().slice(0, 10)} (A), kiểm tra ${new Date(SPLIT).toISOString().slice(0, 10)}→nay (B). Mua/bán ở giá mở cửa hôm sau, phí 0.1%/lần.`);
const results = [];
for (const asset of ['BTC', 'ETH', 'ALT']) {
  const rows = strategies.map((s) => ({ s, A: backtest(R[asset], s.make(), START, split), B: backtest(R[asset], s.make(), split, n) }));
  results.push({ asset, rows });
  const bhA = rows[0].A;
  const bhB = rows[0].B;
  log(`\n  === ${asset} === giữ luôn: A ${f(bhA.bhCagr)}%/năm (sụt ${f(bhA.bhDD, 0)}%) · B ${f(bhB.bhCagr)}%/năm (sụt ${f(bhB.bhDD, 0)}%)`);
  const fmt = (x) => `${f(x.cagr).padStart(6)}%/năm · sụt ${f(x.maxDD, 0).padStart(3)}% · trong thị trường ${f(x.inMarket, 0).padStart(3)}% thời gian`;
  const pick = (title, list) => {
    log(`  ${title}`);
    list.forEach((r) => log(`   • ${r.s.name}\n       A: ${fmt(r.A)}\n       B: ${fmt(r.B)}`));
  };
  // ranked by risk-adjusted return (CAGR / maxDD) in A, then shown in B
  pick('Tốt nhất ở A (lợi nhuận/rủi ro) → kết quả B:', [...rows].sort((a, b) => b.A.calmar - a.A.calmar).slice(0, 4));
  pick('Đối chứng:', rows.filter((r) => r.s.group === 'trend'));
  const better = (x) => x.calmar > (x.bhCagr / 100) / Math.max(x.bhDD / 100, 0.05);
  log(`  Số chiến lược tốt hơn "giữ luôn" (lợi nhuận/rủi ro): A ${rows.filter((r) => better(r.A)).length}/${rows.length} · B ${rows.filter((r) => better(r.B)).length}/${rows.length} · cả hai ${rows.filter((r) => better(r.A) && better(r.B)).length}`);
}

// ---------- 3. DCA: buy every week vs only in fear ----------
log('\n3) Mua đều mỗi tuần (DCA) so với chỉ mua trong tuần "sợ hãi" (cùng tổng tiền, tiền chưa mua để không):');
for (const asset of ['BTC', 'ETH']) {
  const p = prices[`${asset}USDT`];
  for (const [from, to, name] of [[START, split, 'A'], [split, n, 'B']]) {
    const weekly = [];
    for (let i = from; i < to - 1; i += 7) weekly.push(i);
    const last = p.get(days[to - 1]).c;
    const dca = weekly.reduce((a, i) => a + 1 / p.get(days[i + 1]).o, 0) * last / weekly.length;
    // fear DCA: the same weekly budget accumulates and is spent only in weeks where F&G ≤ 30
    let cash = 0;
    let coins = 0;
    for (const i of weekly) {
      cash += 1;
      if (FG[i] <= 30) {
        coins += cash / p.get(days[i + 1]).o;
        cash = 0;
      }
    }
    const fearVal = (coins * last + cash) / weekly.length;
    log(`   ${asset} ${name}: DCA mỗi tuần → mỗi 1$ thành ${f(dca, 2)}$ · chỉ mua khi F&G ≤ 30 → ${f(fearVal, 2)}$ (${f(((fearVal / dca) - 1) * 100)}% so với DCA)`);
  }
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), split: new Date(SPLIT).toISOString(), results: results.map((x) => ({ asset: x.asset, rows: x.rows.map((r) => ({ name: r.s.name, A: r.A, B: r.B })) })) }, null, 1));
log(`\nĐã lưu: ${OUT}`);
