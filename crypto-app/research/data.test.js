import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachDerivatives } from './data.js';

const H = 3_600_000;

test('derivatives are aligned on candle close and never use later snapshots', () => {
  const t0 = Date.UTC(2025, 0, 1);
  const s = { t: [t0, t0 + 4 * H, t0 + 8 * H] }; // 4h candles
  const funding = [[t0 + 1, 0.0001, 8], [t0 + 8 * H + 1, 0.0003, 8]];
  // snapshots at :55 — the one at 03:55 belongs to candle 0, 04:55 must NOT leak into candle 0
  const metrics = [
    [t0 + 3 * H + 55 * 60_000, 100, 1, 1, 1, 1, 1],
    [t0 + 4 * H + 55 * 60_000, 200, 1, 1, 1, 1, 1],
    [t0 + 7 * H + 55 * 60_000, 300, 1, 1, 1, 1, 1],
  ];
  attachDerivatives(s, funding, metrics, 4 * H);
  assert.deepEqual(s.oi, [100, 300, 300]);
  assert.deepEqual(s.fund, [0.0001, 0, 0.0003]);
  assert.deepEqual(s.fundRate, [0.0001, 0.0001, 0.0003]);
});

test('funding after the archive ends keeps charging the last known rate every interval', () => {
  const t0 = Date.UTC(2025, 0, 1);
  const s = { t: [0, 1, 2, 3, 4, 5].map((k) => t0 + k * 4 * H) };
  attachDerivatives(s, [[t0, 0.0002, 8]], [], 4 * H);
  assert.deepEqual(s.fund, [0.0002, 0, 0.0002, 0, 0.0002, 0]);
});
