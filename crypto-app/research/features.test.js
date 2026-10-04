import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureSeries, rollingRank } from './features.js';
import { syntheticSeries } from './data.js';

const cut = (s, m) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, m) : v]));

test('library has hundreds of indicators', () => {
  const s = syntheticSeries('X', 600, 1);
  const F = buildFeatureSeries(s, { btc: syntheticSeries('BTC', 600, 2) });
  assert.ok(F.length >= 200, `only ${F.length}`);
  assert.equal(new Set(F.map((f) => f.id)).size, F.length, 'duplicate ids');
});

test('no feature uses future data: values on a prefix equal values on the full series', () => {
  const full = syntheticSeries('X', 700, 3);
  const btc = syntheticSeries('BTC', 700, 4);
  const m = 450;
  const A = buildFeatureSeries(full, { btc });
  const B = buildFeatureSeries(cut(full, m), { btc: cut(btc, m) });
  assert.equal(A.length, B.length);
  for (let k = 0; k < A.length; k++) {
    for (let i = 0; i < m; i++) {
      const a = A[k].series[i];
      const b = B[k].series[i];
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      assert.ok(Math.abs(a - b) <= 1e-8 * (1 + Math.abs(a)), `${A[k].id} differs at ${i}: ${a} vs ${b}`);
    }
  }
});

test('rollingRank is causal and bounded', () => {
  const s = syntheticSeries('X', 500, 5).c;
  const full = rollingRank(s, 100);
  const part = rollingRank(s.slice(0, 300), 100);
  for (let i = 0; i < 300; i++) assert.equal(full[i], part[i]);
  assert.ok(full.every((r) => r === 255 || (r >= 0 && r <= 100)));
  assert.equal(rollingRank([1, 2, 3, 4, 5], 3).every((r) => r === 255), true); // too little history
});
