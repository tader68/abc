#!/usr/bin/env node
// Study 2 — fundamentals: do tokens whose protocol/chain FEES grow outperform?
// Fees per protocol/chain from DefiLlama (daily), prices from Binance (daily).
// Every month: rank eligible tokens by a fee signal, hold the top third equally weighted for one
// month, compare with the bottom third and with holding every eligible token. Signals use fee data
// up to 2 days before the rebalance (reporting lag). Search period → untouched test period.
//
//   node research/fundamentals.js [--split 2024-01] [--out fundamentals-results.json]
import { writeFileSync } from 'node:fs';
import { fetchSpotHistory } from './data.js';
import { parseArgs } from './common.js';
import { tStat } from './stats.js';

const args = parseArgs(process.argv.slice(2));
const SPLIT = Date.parse(`${args.split || '2024-01'}-01T00:00:00Z`);
const OUT = args.out || 'fundamentals-results.json';
const DAY = 86_400_000;
const COST = 0.002; // per unit of turnover (fees + slippage)
const LAG = 2; // days of reporting lag for fee data
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// DefiLlama slug → Binance base asset (protocols and chains with ≥1 year of fee history)
const UNIVERSE = [
  ['bitcoin', 'BTC'], ['litecoin', 'LTC'], ['ethereum', 'ETH'], ['zcash', 'ZEC'], ['axie-infinity', 'AXS'], ['cardano', 'ADA'],
  ['uniswap', 'UNI'], ['compound-finance', 'COMP'], ['sky', 'SKY'], ['ens', 'ENS'], ['stellar', 'XLM'], ['tron', 'TRX'],
  ['yearn-finance', 'YFI'], ['bsc', 'BNB'], ['sushi', 'SUSHI'], ['polygon', 'POL'], ['near', 'NEAR'], ['curve-finance', 'CRV'],
  ['aave', 'AAVE'], ['solana', 'SOL'], ['liquity', 'LQTY'], ['thorchain', 'RUNE'], ['pancakeswap', 'CAKE'], ['lido', 'LDO'],
  ['convex-finance', 'CVX'], ['injective', 'INJ'], ['arbitrum', 'ARB'], ['gmx', 'GMX'], ['synthetix', 'SNX'], ['benqi', 'QI'],
  ['tezos', 'XTZ'], ['ethereum-classic', 'ETC'], ['starknet', 'STRK'], ['gains-network', 'GNS'], ['stargate-finance', 'STG'],
  ['raydium', 'RAY'], ['aptos', 'APT'], ['avalanche', 'AVAX'], ['layerzero', 'ZRO'], ['jito', 'JTO'], ['dodo', 'DODO'],
  ['the-graph', 'GRT'], ['jupiter', 'JUP'], ['blur', 'BLUR'], ['zksync-era', 'ZK'], ['chiliz', 'CHZ'], ['icp', 'ICP'],
  ['pendle', 'PENDLE'], ['venus', 'XVS'], ['aerodrome', 'AERO'], ['kamino', 'KMNO'], ['dydx', 'DYDX'], ['ethena', 'ENA'],
  ['celestia', 'TIA'], ['morpho', 'MORPHO'], ['pump.fun', 'PUMP'], ['frax', 'FRAX'], ['ether.fi', 'ETHFI'], ['sui', 'SUI'],
  ['spark', 'SPK'], ['sei', 'SEI'], ['livepeer', 'LPT'], ['hedera', 'HBAR'], ['filecoin', 'FIL'], ['eigenlayer', 'EIGEN'],
  ['xrpl', 'XRP'], ['orca', 'ORCA'], ['flow', 'FLOW'], ['hyperliquid', 'HYPE'], ['berachain', 'BERA'], ['algorand', 'ALGO'],
  ['movement', 'MOVE'], ['ondo-finance', 'ONDO'], ['cosmos-hub', 'ATOM'], ['wormhole', 'W'], ['polkadot', 'DOT'],
  ['bitcoin-cash', 'BCH'], ['dash', 'DASH'],
];

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
  throw new Error(url);
};

log(`Tải phí (DefiLlama) và giá (Binance) cho ${UNIVERSE.length} token...`);
const FROM = Date.UTC(2020, 5, 1);
const tokens = [];
for (const [slug, base] of UNIVERSE) {
  try {
    const [fees, px] = await Promise.all([getJson(`https://api.llama.fi/summary/fees/${slug}?dataType=dailyFees`), fetchSpotHistory(`${base}USDT`, '1d', FROM)]);
    const F = new Map((fees.totalDataChart || []).map(([t, v]) => [Math.floor((t * 1000) / DAY), +v || 0]));
    const P = new Map([...px.t].map((t, i) => [Math.floor(t / DAY), px.o[i]])); // daily open
    if (P.size > 60 && F.size > 365) tokens.push({ base, slug, F, P });
  } catch (e) {
    log(`  bỏ ${base}: ${e.message.slice(0, 60)}`);
  }
}
log(`${tokens.length} token có đủ dữ liệu\n`);

const sumF = (tk, d0, d1) => {
  // sum of fees on days [d0, d1); null if the series does not cover the window
  let s = 0;
  let seen = 0;
  for (let d = d0; d < d1; d++) {
    if (tk.F.has(d)) {
      s += tk.F.get(d);
      seen++;
    }
  }
  return seen >= (d1 - d0) * 0.9 ? s : null;
};
const price = (tk, d) => {
  for (let k = 0; k < 3; k++) if (tk.P.has(d + k)) return tk.P.get(d + k);
  return null;
};
const lnr = (a, b) => (a > 0 && b > 0 ? Math.log(a / b) : NaN);

const SIGNALS = {
  'Phí 30 ngày tăng so với 60 ngày trước đó': (tk, d) => {
    const a = sumF(tk, d - 30, d);
    const b = sumF(tk, d - 90, d - 30);
    return a > 30_000 && b > 0 ? lnr(a, b / 2) : NaN;
  },
  'Phí 90 ngày tăng so với 90 ngày trước đó': (tk, d) => {
    const a = sumF(tk, d - 90, d);
    const b = sumF(tk, d - 180, d - 90);
    return a > 90_000 ? lnr(a, b) : NaN;
  },
  'Phí tăng NHANH HƠN giá (90 ngày) — "rẻ đi"': (tk, d) => {
    const a = sumF(tk, d - 90, d);
    const b = sumF(tk, d - 180, d - 90);
    const p0 = price(tk, d + LAG);
    const p1 = price(tk, d + LAG - 90);
    return a > 90_000 ? lnr(a, b) - lnr(p0, p1) : NaN;
  },
  'Phí tăng so với cùng kỳ năm trước': (tk, d) => {
    const a = sumF(tk, d - 90, d);
    const b = sumF(tk, d - 455, d - 365);
    return a > 90_000 ? lnr(a, b) : NaN;
  },
  'Phí tăng nhanh hơn giá (1 năm)': (tk, d) => {
    const a = sumF(tk, d - 90, d);
    const b = sumF(tk, d - 455, d - 365);
    const p0 = price(tk, d + LAG);
    const p1 = price(tk, d + LAG - 365);
    return a > 90_000 ? lnr(a, b) - lnr(p0, p1) : NaN;
  },
};

// month starts
const months = [];
for (let y = 2021; y <= 2026; y++)
  for (let m = 0; m < 12; m++) {
    const d = Math.floor(Date.UTC(y, m, 1) / DAY);
    if (d * DAY < Date.now() - 31 * DAY) months.push(d);
  }

const results = {};
for (const [name, sig] of Object.entries(SIGNALS)) {
  const rows = [];
  let prevTop = new Set();
  for (let k = 0; k + 1 < months.length; k++) {
    const d = months[k];
    const dNext = months[k + 1];
    const cand = [];
    for (const tk of tokens) {
      const s = sig(tk, d - LAG);
      const p0 = price(tk, d);
      const p1 = price(tk, dNext);
      if (Number.isFinite(s) && p0 && p1) cand.push({ tk, s, r: p1 / p0 - 1 });
    }
    if (cand.length < 9) continue;
    cand.sort((a, b) => b.s - a.s);
    const third = Math.floor(cand.length / 3);
    const top = cand.slice(0, third);
    const bot = cand.slice(-third);
    const mean = (xs) => xs.reduce((a, x) => a + x.r, 0) / xs.length;
    const topSet = new Set(top.map((x) => x.tk.base));
    const turnover = [...topSet].filter((b) => !prevTop.has(b)).length / topSet.size;
    prevTop = topSet;
    rows.push({ month: new Date(d * DAY).toISOString().slice(0, 7), n: cand.length, top: mean(top) - turnover * COST * 2, bot: mean(bot), all: mean(cand), picks: top.map((x) => x.tk.base) });
  }
  results[name] = rows;
}

const summarize = (rows) => {
  const comp = (k) => (rows.reduce((a, r) => a * (1 + r[k]), 1) - 1) * 100;
  const ex = rows.map((r) => r.top - r.all);
  const ls = rows.map((r) => r.top - r.bot);
  return {
    months: rows.length,
    top: comp('top'),
    all: comp('all'),
    bot: comp('bot'),
    excess: (ex.reduce((a, b) => a + b, 0) / ex.length) * 100,
    exT: tStat(ex),
    beatPct: (ex.filter((x) => x > 0).length / ex.length) * 100,
    lsT: tStat(ls),
  };
};
log(`Mỗi tháng: mua 1/3 số token có tín hiệu cao nhất, giữ 1 tháng (đã trừ phí giao dịch). Giai đoạn A: đến ${new Date(SPLIT).toISOString().slice(0, 7)} · B: sau đó (kiểm tra).\n`);
const out = {};
for (const [name, rows] of Object.entries(results)) {
  const A = summarize(rows.filter((r) => Date.parse(`${r.month}-01`) < SPLIT));
  const B = summarize(rows.filter((r) => Date.parse(`${r.month}-01`) >= SPLIT));
  out[name] = { A, B, last: rows[rows.length - 1] };
  const line = (x) =>
    `${x.months} tháng · nhóm đầu ${f(x.top, 0)}% · tất cả ${f(x.all, 0)}% · nhóm cuối ${f(x.bot, 0)}% · vượt TB ${f(x.excess, 2)}%/tháng (t=${f(x.exT)}) · thắng ${f(x.beatPct, 0)}% số tháng · đầu−cuối t=${f(x.lsT)}`;
  log(`• ${name}\n   A: ${line(A)}\n   B: ${line(B)}`);
}
const best = Object.entries(out).sort((a, b) => b[1].A.exT - a[1].A.exT)[0];
log(`\nTín hiệu mạnh nhất ở A: "${best[0]}" → ở B: vượt TB ${f(best[1].B.excess, 2)}%/tháng (t=${f(best[1].B.exT)})`);
log(`Danh sách tháng gần nhất (${best[1].last.month}) theo tín hiệu này: ${best[1].last.picks.join(', ')}`);
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), split: new Date(SPLIT).toISOString(), tokens: tokens.map((t) => t.base), results: out, monthly: results }, null, 1));
log(`Đã lưu: ${OUT}`);
