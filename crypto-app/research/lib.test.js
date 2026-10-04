import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, WARMUP, atr } from './lib.js';

const flat = (n) => ({
  t: Array.from({ length: n }, (_, i) => i),
  o: new Array(n).fill(100),
  h: new Array(n).fill(101),
  l: new Array(n).fill(99),
  c: new Array(n).fill(100),
  v: new Array(n).fill(1),
});

const setup = () => {
  const s = flat(WARMUP + 10);
  const sig = new Int8Array(s.c.length);
  return { s, sig, a: atr(s, 14) }; // ATR = 2
};

test('long hits take-profit: size by 1% risk, fees and slippage applied', () => {
  const { s, sig, a } = setup();
  const i = WARMUP + 2;
  sig[i - 1] = 1;
  s.h[i + 1] = 105;
  const r = runBacktest(s, sig, a, { slMult: 1, tpMult: 2 }, 'futures', 0, s.c.length);
  assert.equal(r.trades, 1);
  assert.ok(r.ret > 1.7 && r.ret < 2.0, `ret=${r.ret}`); // ~ +4% on 0.5x notional, minus costs
});

test('stop-loss is taken first when SL and TP sit in the same bar', () => {
  const { s, sig, a } = setup();
  const i = WARMUP + 2;
  sig[i - 1] = 1;
  s.h[i + 1] = 110;
  s.l[i + 1] = 90;
  const r = runBacktest(s, sig, a, { slMult: 1, tpMult: 2 }, 'futures', 0, s.c.length);
  assert.equal(r.trades, 1);
  assert.ok(r.ret < 0);
});

test('spot never opens shorts; futures does', () => {
  const { s, sig, a } = setup();
  sig[WARMUP + 1] = -1;
  assert.equal(runBacktest(s, sig, a, { slMult: 1, tpMult: 0 }, 'spot', 0, s.c.length).trades, 0);
  assert.equal(runBacktest(s, sig, a, { slMult: 1, tpMult: 0 }, 'futures', 0, s.c.length).trades, 1);
});

test('signal on the last bar cannot be traded (no look-ahead)', () => {
  const { s, sig, a } = setup();
  sig[s.c.length - 1] = 1;
  assert.equal(runBacktest(s, sig, a, { slMult: 1, tpMult: 0 }, 'futures', 0, s.c.length).trades, 0);
});

test('futures longs pay positive funding, shorts receive it; spot ignores it', () => {
  const run = (dir, market) => {
    const { s, sig, a } = setup();
    s.fund = new Array(s.c.length).fill(0.001);
    sig[WARMUP + 1] = dir;
    return runBacktest(s, sig, a, { slMult: 1, tpMult: 0 }, market, 0, s.c.length).ret;
  };
  const { s, sig, a } = setup();
  sig[WARMUP + 1] = 1;
  const base = runBacktest(s, sig, a, { slMult: 1, tpMult: 0 }, 'futures', 0, s.c.length).ret;
  assert.ok(run(1, 'futures') < base);
  assert.ok(run(-1, 'futures') > base);
  assert.ok(Math.abs(run(1, 'spot') - runBacktest(s, sig, a, { slMult: 1, tpMult: 0 }, 'spot', 0, s.c.length).ret) < 1e-12);
});
