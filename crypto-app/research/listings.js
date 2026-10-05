#!/usr/bin/env node
// Study 3 — new Binance spot listings: what happens to price in the first year?
// All USDT pairs ever listed (including delisted ones) from the data.binance.vision archive,
// listings since 2020. Returns from the first day's open / close and after the first week,
// compared with BTC over the same window, by listing year.
//
//   node research/listings.js [--from 2020-01] [--out listings-results.json]
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fetchSpotHistory } from './data.js';
import { parseArgs } from './common.js';

const args = parseArgs(process.argv.slice(2));
const FROM = args.from || '2020-01';
const OUT = args.out || 'listings-results.json';
const DAY = 86_400_000;
const S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const ARCH = 'https://data.binance.vision';
const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const STABLES = new Set(['USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'DAI', 'PAX', 'EUR', 'GBP', 'AUD', 'USDS', 'SUSD', 'UST', 'AEUR', 'EURI', 'XUSD', 'USD1', 'BFUSD', 'RLUSD', 'PAXG']);
const log = (m) => console.log(m);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

const text = async (url) => {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.text();
      if (r.status === 404) return null;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 1500 * (k + 1)));
  }
  return null;
};
const pool = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
};
const listKeys = async (prefix, delimiter = '') => {
  const keys = [];
  let marker = '';
  for (;;) {
    const x = await text(`${S3}?prefix=${prefix}${delimiter ? `&delimiter=${delimiter}` : ''}${marker ? `&marker=${marker}` : ''}`);
    if (!x) break;
    const found = delimiter ? [...x.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix) : [...x.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    keys.push(...found);
    if (!x.includes('<IsTruncated>true</IsTruncated>') || !found.length) break;
    marker = found[found.length - 1];
  }
  return keys;
};
const unzipCsv = (buf) => {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
};
const zipRows = async (url) => {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return [];
      if (r.ok) {
        return unzipCsv(Buffer.from(await r.arrayBuffer()))
          .split('\n')
          .map((l) => l.trim().split(','))
          .filter((x) => /^\d/.test(x[0]))
          .map((x) => {
            let t = +x[0];
            if (t > 1e14) t = Math.floor(t / 1000);
            return [t, +x[1], +x[2], +x[3], +x[4]];
          });
      }
    } catch {
      /* retry */
    }
  }
  return [];
};

// ---------- 1. every USDT pair ever listed ----------
log('Lấy danh sách mọi cặp USDT từng niêm yết...');
const symbols = (await listKeys('data/spot/monthly/klines/', '/'))
  .map((p) => p.split('/')[4])
  .filter((s) => s && s.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s) && !STABLES.has(s.slice(0, -4)));
log(`  ${symbols.length} cặp USDT`);

// ---------- 2. first year of daily candles for listings since FROM ----------
const btc = await fetchSpotHistory('BTCUSDT', '1d', Date.UTC(2019, 11, 1));
const btcOpen = new Map([...btc.t].map((t, i) => [Math.floor(t / DAY), btc.o[i]]));
const btcAt = (d) => {
  for (let k = 0; k < 5; k++) if (btcOpen.has(d + k)) return btcOpen.get(d + k);
  return null;
};
let done = 0;
const events = (
  await pool(symbols, 12, async (sym) => {
    const keys = (await listKeys(`data/spot/monthly/klines/${sym}/1d/`)).filter((k) => k.endsWith('.zip'));
    const months = keys.map((k) => k.match(/(\d{4}-\d{2})\.zip$/)?.[1]).filter(Boolean).sort();
    if (++done % 100 === 0) log(`  ${done}/${symbols.length}`);
    if (!months.length || months[0] < FROM) return null;
    const rows = (await Promise.all(months.slice(0, 14).map((m) => zipRows(`${ARCH}/data/spot/monthly/klines/${sym}/1d/${sym}-1d-${m}.zip`)))).flat();
    if (rows.length < 360) {
      // listed recently: complete with the REST mirror (works only while the pair still trades)
      const start = rows.length ? rows[rows.length - 1][0] + DAY : Date.parse(`${months[0]}-01`);
      const extra = await text(`${MIRROR}?symbol=${sym}&interval=1d&limit=1000&startTime=${start}`);
      if (extra) {
        try {
          JSON.parse(extra).forEach((k) => rows.push([k[0], +k[1], +k[2], +k[3], +k[4]]));
        } catch {
          /* not trading any more */
        }
      }
    }
    rows.sort((a, b) => a[0] - b[0]);
    return rows.length >= 8 ? { sym, rows } : null;
  })
).filter(Boolean);
log(`  ${events.length} coin niêm yết từ ${FROM}\n`);

// ---------- 3. returns ----------
const HORIZONS = [7, 30, 90, 180, 365];
const ENTRIES = {
  'mua ở giá mở cửa ngày đầu': (rows) => ({ day: 0, px: rows[0][1] }),
  'mua ở giá đóng cửa ngày đầu': (rows) => ({ day: 1, px: rows[0][4] }),
  'mua sau 1 tuần': (rows) => (rows.length > 7 ? { day: 7, px: rows[7][1] } : null),
  'mua sau 1 tháng': (rows) => (rows.length > 30 ? { day: 30, px: rows[30][1] } : null),
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const results = {};
for (const [entryName, entry] of Object.entries(ENTRIES)) {
  results[entryName] = {};
  for (const h of HORIZONS) {
    const byYear = {};
    for (const ev of events) {
      const e = entry(ev.rows);
      if (!e) continue;
      const exitIdx = e.day + h;
      if (exitIdx >= ev.rows.length) {
        // delisted before the horizon: count it at its last price (the coin did not survive)
        if (ev.rows.length < 360 && Date.now() - ev.rows[ev.rows.length - 1][0] > 30 * DAY) {
          /* fall through with last price */
        } else continue;
      }
      const exit = ev.rows[Math.min(exitIdx, ev.rows.length - 1)];
      const r = exit[4] / e.px - 1;
      const d0 = Math.floor(ev.rows[0][0] / DAY) + e.day;
      const b0 = btcAt(d0);
      const b1 = btcAt(Math.floor(exit[0] / DAY));
      const rb = b0 && b1 ? b1 / b0 - 1 : NaN;
      const y = new Date(ev.rows[0][0]).getUTCFullYear();
      (byYear[y] ||= []).push({ sym: ev.sym, r, ex: r - rb });
      (byYear.all ||= []).push({ sym: ev.sym, r, ex: r - rb });
    }
    results[entryName][h] = Object.fromEntries(
      Object.entries(byYear).map(([y, xs]) => [
        y,
        {
          n: xs.length,
          median: median(xs.map((x) => x.r)) * 100,
          positive: (xs.filter((x) => x.r > 0).length / xs.length) * 100,
          beatBtc: (xs.filter((x) => x.ex > 0).length / xs.length) * 100,
          medianEx: median(xs.map((x) => x.ex)) * 100,
          mean: (xs.reduce((a, x) => a + x.r, 0) / xs.length) * 100,
        },
      ]),
    );
  }
}

const years = [...new Set(events.map((e) => new Date(e.rows[0][0]).getUTCFullYear()))].sort();
log('Lợi nhuận TRUNG VỊ của coin mới niêm yết (và % số coin thắng BTC cùng kỳ):\n');
for (const entryName of Object.keys(ENTRIES)) {
  log(`== ${entryName} ==`);
  log('  giữ    ' + ['tất cả', ...years].map((y) => String(y).padStart(16)).join(''));
  for (const h of HORIZONS) {
    const row = results[entryName][h];
    log(`  ${String(h).padStart(3)} ngày` + ['all', ...years].map((y) => (row[y] && row[y].n >= 5 ? `${f(row[y].median, 0).padStart(5)}% (${f(row[y].beatBtc, 0).padStart(2)}%)` : '—').padStart(16)).join(''));
  }
  log('');
}
const r90 = results['mua ở giá đóng cửa ngày đầu'][90].all;
log(`Mua coin mới ở giá đóng cửa ngày đầu, giữ 90 ngày: trung vị ${f(r90.median)}% · ${f(r90.positive, 0)}% số coin có lãi · ${f(r90.beatBtc, 0)}% thắng BTC · trung bình ${f(r90.mean)}% (bị kéo lên bởi vài coin tăng rất mạnh)`);
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), listings: events.map((e) => ({ symbol: e.sym, listed: new Date(e.rows[0][0]).toISOString().slice(0, 10) })), results }, null, 1));
log(`Đã lưu: ${OUT}`);
