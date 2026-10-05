#!/usr/bin/env node
// Verify trading signals from a channel against real Binance prices (5m candles).
// One signal per line in a text file:
//   2026-10-05 21:25 | LINK | short | 14.047 | 14.35 | 13.8349, 13.744, 13.441
//   (post time in Vietnam time UTC+7 | coin | long/short | entry | stop | TP1, TP2, TP3)
// For each signal: was the entry reached after the post? If so, which came first — stop or TPs?
// The result assumes the position is closed in three equal parts at TP1/TP2/TP3 (stop on the rest),
// with Binance futures fees.
//
//   node research/signals.js signals.txt [--hours 72] [--tz 7]
import { readFileSync } from 'node:fs';
import { parseArgs } from './common.js';

const args = parseArgs(process.argv.slice(3));
const FILE = process.argv[2];
const MAX_H = +args.hours || 72; // give up if nothing happens within this many hours
const TZ = args.tz !== undefined ? +args.tz : 7;
const FEE = 0.0005 + 0.0002;
if (!FILE) {
  console.log('Cách dùng: node research/signals.js signals.txt');
  process.exit(1);
}
const num = (x) => +String(x).trim().replace(/\s/g, '').replace(',', '.');
const signals = readFileSync(FILE, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [when, coin, side, entry, stop, tps] = l.split('|').map((x) => x.trim());
    return {
      t: Date.parse(when.replace(' ', 'T') + ':00Z') - TZ * 3_600_000,
      coin: coin.toUpperCase().replace(/USDT$/, ''),
      dir: /short|bán|giảm/i.test(side) ? -1 : 1,
      entry: num(entry),
      stop: num(stop),
      // TPs are separated by ';', ', ' (comma + space) or spaces; a comma without a space is a decimal comma
      tps: tps.split(/;|,\s+|\s+/).filter(Boolean).map(num).filter(Number.isFinite),
    };
  });

const klines = async (sym, from) => {
  const out = [];
  let start = from;
  while (out.length < (MAX_H * 12)) {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=5m&limit=1000&startTime=${start}`);
    if (!r.ok) break;
    const page = await r.json();
    if (!page.length) break;
    out.push(...page.map((k) => ({ t: k[0], h: +k[2], l: +k[3], c: +k[4] })));
    if (page.length < 1000) break;
    start = page[page.length - 1][0] + 1;
  }
  return out.slice(0, MAX_H * 12);
};

const results = [];
for (const s of signals) {
  const k = await klines(s.coin, s.t);
  const label = `${new Date(s.t + TZ * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} ${s.coin} ${s.dir > 0 ? 'LONG' : 'SHORT'} @${s.entry}`;
  const fill = k.findIndex((b) => (s.dir < 0 ? b.h >= s.entry : b.l <= s.entry));
  if (fill < 0) {
    results.push({ label, status: 'không khớp', r: 0 });
    continue;
  }
  const risk = Math.abs(s.stop - s.entry) / s.entry;
  let open = s.tps.length;
  let pnl = 0;
  let status = 'chưa kết thúc';
  const hitTp = new Set();
  for (let i = fill; i < k.length && open > 0; i++) {
    const b = k[i];
    // stop first when a candle touches both (conservative)
    if (s.dir < 0 ? b.h >= s.stop : b.l <= s.stop) {
      pnl += (open / s.tps.length) * -risk;
      status = hitTp.size ? `TP${hitTp.size} rồi cắt lỗ phần còn lại` : 'CẮT LỖ';
      open = 0;
      break;
    }
    s.tps.forEach((tp, j) => {
      if (hitTp.has(j)) return;
      if (s.dir < 0 ? b.l <= tp : b.h >= tp) {
        hitTp.add(j);
        pnl += (1 / s.tps.length) * (Math.abs(tp - s.entry) / s.entry);
        open--;
      }
    });
    if (open === 0) status = `chạm đủ ${s.tps.length} TP`;
  }
  if (open > 0) {
    const last = k[k.length - 1].c;
    pnl += (open / s.tps.length) * ((s.dir * (last - s.entry)) / s.entry);
    status = hitTp.size ? `TP${hitTp.size}, phần còn lại đang mở` : 'đang mở';
  }
  pnl -= 2 * FEE;
  results.push({ label, status, r: pnl, risk });
}

console.log('Kết quả từng tín hiệu (lãi/lỗ trên giá trị lệnh, đã trừ phí, chia đều 3 phần chốt ở TP1/TP2/TP3):');
for (const r of results) console.log(`  ${r.label.padEnd(36)} → ${r.status.padEnd(28)} ${r.status === 'không khớp' ? '' : `${(r.r * 100).toFixed(2)}%`}`);
const done = results.filter((r) => r.status !== 'không khớp');
const wins = done.filter((r) => r.r > 0).length;
const total = done.reduce((a, r) => a + r.r, 0);
console.log(`\nTổng: ${signals.length} tín hiệu · ${signals.length - done.length} không khớp · ${done.length} có lệnh · thắng ${wins}/${done.length} · tổng lãi/lỗ ${(total * 100).toFixed(2)}% (nếu mỗi lệnh dùng cùng một số vốn, đòn bẩy 1x)`);
