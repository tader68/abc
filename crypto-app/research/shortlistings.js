#!/usr/bin/env node
// Study 3b — shorting newly listed tokens on Binance USDT-M perpetuals.
// Every perp listed since 2021 whose token did not already trade on Binance spot at the end of 2020.
// Short X days after the perp lists, hold up to H days, with a stop-loss and optional take-profit.
// 4h candles (stops/liquidations checked on each candle's high), funding paid/received on every
// funding event, taker fees + wide slippage for thin new markets. 1x isolated margin: a +95% move
// liquidates the position (−100% of the margin put in).
//
//   node research/shortlistings.js [--out shortlistings-results.json]
import { writeFileSync } from 'node:fs';
import { archiveFile, csvRows, pool, s3List } from './data.js';
import { parseArgs } from './common.js';
import { tStat } from './stats.js';

const args = parseArgs(process.argv.slice(2));
const OUT = args.out || 'shortlistings-results.json';
const SPLIT = Date.parse('2024-01-01T00:00:00Z');
const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const FEE = 0.0005;
const SLIP = +(args.slip || 0.001); // slippage per side (new listings are thin; try --slip 0.01)
const LIQ = 0.95;
const SPOT = 'https://data.binance.vision/data/spot';
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// ---------- universe ----------
log('Lấy danh sách hợp đồng futures...');
const perps = (await s3List('data/futures/um/monthly/klines/', '/'))
  .map((p) => p.split('/')[5])
  .filter((s) => s && s.endsWith('USDT') && !s.includes('_') && !/^(BTC|ETH|BNB|USDC|BUSD|TUSD|FDUSD|USDP|DAI)USDT$/.test(s));
log(`  ${perps.length} hợp đồng USDT`);

let done = 0;
const events = (
  await pool(perps, 12, async (sym) => {
    if (++done % 100 === 0) log(`  ${done}/${perps.length}`);
    const keys = (await s3List(`data/futures/um/monthly/klines/${sym}/4h/`)).filter((k) => k.endsWith('.zip'));
    const months = keys.map((k) => k.match(/(\d{4}-\d{2})\.zip$/)?.[1]).filter(Boolean).sort();
    if (!months.length || months[0] < '2021-01') return null;
    // skip tokens that already traded on spot at the end of 2020 (old coins getting a new perp)
    const base = sym.replace(/^(1000000|1000|1M)/, '').slice(0, -4);
    const oldSpot = await archiveFile(`monthly/klines/${base}USDT/1d/${base}USDT-1d-2020-12.zip`, false, SPOT).catch(() => null);
    if (oldSpot) return null;
    const use = months.slice(0, 8); // first ~7 months are enough for a 180-day hold after a delay
    const [kl, fu] = await Promise.all([
      Promise.all(use.map((m) => archiveFile(`monthly/klines/${sym}/4h/${sym}-4h-${m}.zip`, true).catch(() => null))),
      Promise.all(use.map((m) => archiveFile(`monthly/fundingRate/${sym}/${sym}-fundingRate-${m}.zip`, true).catch(() => null))),
    ]);
    const bars = kl.flatMap(csvRows).map((r) => [+r[0] > 1e14 ? Math.floor(+r[0] / 1000) : +r[0], +r[1], +r[2], +r[3], +r[4]]).sort((a, b) => a[0] - b[0]);
    const funding = fu.flatMap(csvRows).map((r) => [+r[0], +r[2]]).sort((a, b) => a[0] - b[0]);
    if (bars.length <= 6 * 7) return null;
    // funding prefix sums aligned to bars: cum[k] = Σ rate × close for funding events in bars < k
    const cum = new Float64Array(bars.length + 1);
    let j = 0;
    for (let k = 0; k < bars.length; k++) {
      let s = 0;
      while (j < funding.length && funding[j][0] < bars[k][0] + H4) {
        if (funding[j][0] >= bars[k][0]) s += funding[j][1] * bars[k][4];
        j++;
      }
      cum[k + 1] = cum[k] + s;
    }
    const recent = months.length <= use.length && months[months.length - 1] >= new Date(Date.now() - 45 * DAY).toISOString().slice(0, 7);
    return { sym, listed: bars[0][0], bars, cum, recent };
  })
).filter(Boolean);
log(`  ${events.length} token mới có hợp đồng futures (từ 2021)\n`);

// ---------- simulation of one short ----------
const VARIANTS = [];
for (const delay of [1, 3, 7, 14])
  for (const hold of [30, 90, 180])
    for (const stop of [0.3, 0.5, 1.0, null])
      for (const tp of [null, 0.5, 0.7]) VARIANTS.push({ delay, hold, stop, tp });
const label = (v) => `short sau ${v.delay} ngày · giữ tối đa ${v.hold} ngày · ${v.stop ? `cắt lỗ +${v.stop * 100}%` : 'không cắt lỗ (cháy ở +95%)'} · ${v.tp ? `chốt lời −${v.tp * 100}%` : 'không chốt sớm'}`;

const shortTrade = (ev, v) => {
  const b = ev.bars;
  const start = ev.listed + v.delay * DAY;
  let i = b.findIndex((x) => x[0] >= start);
  if (i < 0) return null;
  const entry = b[i][1] * (1 - SLIP);
  const tEntry = b[i][0];
  const tEnd = tEntry + v.hold * DAY;
  if (b[b.length - 1][0] < tEnd && ev.recent) return null; // listed too recently: horizon not reached yet
  const stopPx = v.stop ? entry * (1 + v.stop) : entry * (1 + LIQ);
  const tpPx = v.tp ? entry * (1 - v.tp) : 0;
  let exitPx = null;
  let liquidated = false;
  let k = i;
  for (; k < b.length && b[k][0] < tEnd; k++) {
    const [, o, h, l] = b[k];
    if (h >= stopPx) {
      if (!v.stop) liquidated = true;
      exitPx = Math.max(o, stopPx) * (1 + SLIP);
      break;
    }
    if (v.tp && l <= tpPx) {
      exitPx = Math.min(o, tpPx) * (1 + SLIP);
      break;
    }
  }
  if (exitPx === null) {
    k = Math.min(k, b.length) - 1;
    exitPx = b[k][4] * (1 + SLIP);
  }
  const tExit = b[k][0] + H4;
  // funding: shorts receive positive rates and pay negative ones, on the position's current value
  const fund = (ev.cum[k + 1] - ev.cum[i]) / entry;
  let r = -(exitPx / entry - 1) - 2 * FEE + fund;
  if (liquidated || r < -1) r = -1;
  return { r, tEntry, tExit, liquidated, fund };
};

// shared pool: each new short gets 5% of equity as margin, at most 20 at a time
const portfolio = (trades) => {
  const ts = [...trades].sort((a, b) => a.tEntry - b.tEntry);
  let cash = 1;
  const open = [];
  const curve = [];
  const settle = (until) => {
    open.sort((a, b) => a.tExit - b.tExit);
    while (open.length && open[0].tExit <= until) {
      const p = open.shift();
      cash += p.stake * (1 + p.r);
      curve.push([p.tExit, cash + open.reduce((a, q) => a + q.stake, 0)]);
    }
  };
  for (const tr of ts) {
    settle(tr.tEntry);
    if (open.length >= 20) continue;
    const eq = cash + open.reduce((a, q) => a + q.stake, 0);
    const stake = Math.min(cash, eq * 0.05);
    cash -= stake;
    open.push({ ...tr, stake });
  }
  settle(Infinity);
  let peak = 1;
  let mdd = 0;
  const yearEnd = new Map();
  for (const [t, e] of curve) {
    peak = Math.max(peak, e);
    mdd = Math.max(mdd, 1 - e / peak);
    yearEnd.set(new Date(t).getUTCFullYear(), e);
  }
  let prev = 1;
  const years = [...yearEnd.entries()].map(([y, e]) => {
    const r = (e / prev - 1) * 100;
    prev = e;
    return [y, r];
  });
  return { total: ((curve.length ? curve[curve.length - 1][1] : 1) - 1) * 100, maxDD: mdd * 100, years };
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const summary = (trades) => {
  const rs = trades.map((t) => t.r);
  return {
    n: rs.length,
    mean: rs.length ? (rs.reduce((a, b) => a + b, 0) / rs.length) * 100 : NaN,
    median: median(rs) * 100,
    win: rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : NaN,
    t: tStat(rs),
    liq: trades.filter((t) => t.liquidated).length,
    stopped: rs.filter((r) => r < -0.25).length,
    fund: trades.length ? (trades.reduce((a, t) => a + t.fund, 0) / trades.length) * 100 : 0,
  };
};

const res = VARIANTS.map((v) => {
  const trades = events.map((ev) => shortTrade(ev, v)).filter(Boolean);
  const A = trades.filter((t) => t.tEntry < SPLIT);
  const B = trades.filter((t) => t.tEntry >= SPLIT);
  return { v, A: summary(A), B: summary(B), pA: portfolio(A), pB: portfolio(B), all: portfolio(trades) };
});

const line = (s, p) =>
  `${s.n} lệnh · lãi TB ${f(s.mean)}%/lệnh (t=${f(s.t)}) · trung vị ${f(s.median)}% · thắng ${f(s.win, 0)}% · cháy ${s.liq} · funding TB ${f(s.fund)}% · danh mục 5%/lệnh: ${f(p.total, 0)}% (sụt ${f(p.maxDD, 0)}%)`;
log(`Giai đoạn A: token niêm yết 2021–2023 · B: từ 2024 (kiểm tra). Phí ${FEE * 200}% + trượt giá ${SLIP * 200}% mỗi lệnh.\n`);
const show = (title, list) => {
  log(title);
  for (const r of list) {
    log(` • ${label(r.v)}\n   A: ${line(r.A, r.pA)}\n   B: ${line(r.B, r.pB)}`);
    log(`   danh mục theo năm: ${r.all.years.map(([y, x]) => `${y} ${f(x, 0)}%`).join(' · ')}`);
  }
  log('');
};
const ok = res.filter((r) => r.A.n >= 40 && r.B.n >= 40);
show('1) 5 cách short tốt nhất ở A → kết quả ở B:', [...ok].sort((a, b) => b.A.t - a.A.t).slice(0, 5));
show('2) 5 cách ổn định nhất (t-stat tốt ở CẢ HAI giai đoạn):', [...ok].sort((a, b) => Math.min(b.A.t, b.B.t) - Math.min(a.A.t, a.B.t)).slice(0, 5));
show('3) Short đơn giản không cắt lỗ (để thấy rủi ro):', ok.filter((r) => !r.v.stop && !r.v.tp && r.v.delay === 1));
log(`Số cách có lãi TB > 0 với t ≥ 2: A ${ok.filter((r) => r.A.t >= 2).length}/${ok.length} · B ${ok.filter((r) => r.B.t >= 2).length}/${ok.length} · cả hai ${ok.filter((r) => r.A.t >= 2 && r.B.t >= 2).length}`);
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), events: events.map((e) => ({ symbol: e.sym, listed: new Date(e.listed).toISOString().slice(0, 10) })), results: res.map((r) => ({ rule: label(r.v), ...r })) }, null, 1));
log(`Đã lưu: ${OUT}`);
