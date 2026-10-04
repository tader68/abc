import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleSignals } from './search.js';
import { WARMUP } from './lib.js';

test('rule fires once when its conditions become true, mirrored side gives shorts', () => {
  const n = WARMUP + 8;
  const rank = new Uint8Array(n).fill(50);
  rank[WARMUP + 1] = 95; // high -> long condition
  rank[WARMUP + 2] = 96; // still high: no new signal
  rank[WARMUP + 4] = 3; // low -> mirrored (short)
  rank[WARMUP + 6] = 255; // unknown -> nothing
  const sig = ruleSignals({ conds: [{ f: 0, side: 1, q: 90 }], invert: false }, [rank], n);
  assert.deepEqual([...sig.slice(WARMUP, n)], [0, 1, 0, 0, -1, 0, 0, 0]);
  const inv = ruleSignals({ conds: [{ f: 0, side: 1, q: 90 }], invert: true }, [rank], n);
  assert.deepEqual([...inv.slice(WARMUP, n)], [0, -1, 0, 0, 1, 0, 0, 0]);
});
