// Weekly / monthly statistics of an equal-weight portfolio built from per-symbol equity curves.

// curves: Float64Array[] (equity per bar, 1 before the window), times: ms timestamps.
export const portfolioEquity = (curves, from, to) => {
  const eq = [];
  for (let i = from; i < to; i++) eq.push(curves.reduce((a, c) => a + c[i], 0) / curves.length);
  return eq;
};

const periodReturns = (times, eq, keyOf, minBars) => {
  const groups = [];
  let prevEnd = 1;
  let cur = null;
  for (let i = 0; i < eq.length; i++) {
    const key = keyOf(times[i]);
    if (!cur || cur.key !== key) {
      if (cur) prevEnd = cur.end;
      cur = { key, bars: 0, start: prevEnd, end: eq[i] };
      groups.push(cur);
    }
    cur.bars++;
    cur.end = eq[i];
  }
  return groups.filter((g) => g.bars >= minBars).map((g) => ({ key: g.key, ret: (g.end / g.start - 1) * 100 }));
};

const summarise = (rows) => {
  if (!rows.length) return { count: 0, positivePct: 0, worst: 0, best: 0, mean: 0, longestLosingStreak: 0 };
  let streak = 0;
  let longest = 0;
  for (const r of rows) {
    streak = r.ret < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  return {
    count: rows.length,
    positivePct: (rows.filter((r) => r.ret > 0).length / rows.length) * 100,
    worst: Math.min(...rows.map((r) => r.ret)),
    best: Math.max(...rows.map((r) => r.ret)),
    mean: rows.reduce((a, r) => a + r.ret, 0) / rows.length,
    longestLosingStreak: longest,
  };
};

export const periodStats = (times, eq) => {
  const barMs = times.length > 1 ? times[1] - times[0] : 3600_000;
  const week = (t) => Math.floor(t / (7 * 86400_000));
  const month = (t) => new Date(t).toISOString().slice(0, 7);
  const weeks = periodReturns(times, eq, week, Math.floor((7 * 86400_000) / barMs / 2));
  const months = periodReturns(times, eq, month, Math.floor((30 * 86400_000) / barMs / 2));
  let peak = 1;
  let maxDD = 0;
  for (const e of eq) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  return { weekly: summarise(weeks), monthly: summarise(months), maxDD: maxDD * 100, total: (eq[eq.length - 1] - 1) * 100, months };
};

// t-statistic of the mean per-trade return (1 = equity risked per trade scale)
export const tStat = (pnls) => {
  const n = pnls.length;
  if (n < 2) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
};
