// Candidate evaluation + evolutionary search over rules built from the indicator library.
import { runBacktest, WARMUP } from './lib.js';

const UNKNOWN = 255;
export const THRESHOLDS = [70, 80, 90, 95];

// ---------- pooled evaluation across symbols ----------
// ctx = { series[], atrs[], market }
export const evalSigs = (sigs, exits, ctx, from, to, extra = false) => {
  const k = ctx.series.length;
  let ret = 0;
  let dd = 0;
  let score = 0;
  let trades = 0;
  let win = 0;
  let positive = 0;
  const curves = extra ? [] : null;
  const pnls = extra ? [] : null;
  const perSym = extra ? [] : null;
  for (let i = 0; i < k; i++) {
    const curve = extra ? new Float64Array(ctx.series[i].c.length).fill(1) : null;
    const r = runBacktest(ctx.series[i], sigs[i], ctx.atrs[i], exits, ctx.market, from, to, curve, pnls);
    ret += r.ret;
    dd += r.maxDD;
    score += r.score;
    trades += r.trades;
    win += r.winRate;
    if (r.ret > 0) positive++;
    if (extra) {
      curves.push(curve);
      perSym.push({ symbol: ctx.series[i].symbol, ...r });
    }
  }
  return {
    ret: ret / k,
    maxDD: dd / k,
    score: score / k,
    trades: trades / k,
    winRate: win / k,
    breadth: positive / k,
    curves,
    pnls,
    perSym,
  };
};

// ---------- rules ----------
// cond = { f: featureIndex, side: 1 (feature high) | -1 (feature low), q }
// long when ALL conditions hold; short when ALL mirrored conditions hold; `invert` swaps them.
export const ruleKey = (r) => `${r.invert ? '!' : ''}${r.conds.map((c) => `${c.f}${c.side > 0 ? '>' : '<'}${c.q}`).sort().join('&')}`;

export const describeRule = (r, names) =>
  `${r.invert ? 'ĐẢO: ' : ''}` +
  r.conds.map((c) => `${names[c.f]} ${c.side > 0 ? `≥ top ${100 - c.q}%` : `≤ bottom ${100 - c.q}%`}`).join(' VÀ ');

// ranks[si][f] -> Uint8Array. Signal fires on the bar where the condition set becomes true.
export const ruleSignals = (rule, ranks, n, to = n) => {
  const out = new Int8Array(n);
  let prevL = false;
  let prevS = false;
  for (let i = WARMUP; i < to; i++) {
    let L = true;
    let S = true;
    for (const c of rule.conds) {
      const r = ranks[c.f][i];
      if (r === UNKNOWN) {
        L = false;
        S = false;
        break;
      }
      const highOk = c.side > 0 ? r >= c.q : r <= 100 - c.q;
      const lowOk = c.side > 0 ? r <= 100 - c.q : r >= c.q;
      if (!highOk) L = false;
      if (!lowOk) S = false;
      if (!L && !S) break;
    }
    const longNow = rule.invert ? S : L;
    const shortNow = rule.invert ? L : S;
    if (longNow && !prevL) out[i] = 1;
    else if (shortNow && !prevS) out[i] = -1;
    prevL = longNow;
    prevS = shortNow;
  }
  return out;
};

const pick = (rand, a) => a[Math.floor(rand() * a.length)];

const randomCond = (rand, nFeatures, used) => {
  let f;
  do f = Math.floor(rand() * nFeatures);
  while (used.has(f));
  used.add(f);
  return { f, side: rand() < 0.5 ? 1 : -1, q: pick(rand, THRESHOLDS) };
};

export const randomRule = (rand, nFeatures) => {
  const k = rand() < 0.45 ? 1 : rand() < 0.7 ? 2 : 3;
  const used = new Set();
  return { conds: Array.from({ length: k }, () => randomCond(rand, nFeatures, used)), invert: rand() < 0.5 };
};

const mutateRule = (rand, r, nFeatures) => {
  const c = { conds: r.conds.map((x) => ({ ...x })), invert: r.invert };
  const used = new Set(c.conds.map((x) => x.f));
  const roll = rand();
  if (roll < 0.25) c.conds[Math.floor(rand() * c.conds.length)].q = pick(rand, THRESHOLDS);
  else if (roll < 0.45) {
    const x = c.conds[Math.floor(rand() * c.conds.length)];
    x.side = -x.side;
  } else if (roll < 0.7) {
    const idx = Math.floor(rand() * c.conds.length);
    used.delete(c.conds[idx].f);
    c.conds[idx] = randomCond(rand, nFeatures, used);
  } else if (roll < 0.85 && c.conds.length < 3) c.conds.push(randomCond(rand, nFeatures, used));
  else if (roll < 0.95 && c.conds.length > 1) c.conds.splice(Math.floor(rand() * c.conds.length), 1);
  else c.invert = !c.invert;
  return c;
};

const crossRules = (rand, a, b) => {
  const pool = [...a.conds, ...b.conds].map((x) => ({ ...x }));
  const conds = [];
  const used = new Set();
  const want = 1 + Math.floor(rand() * 3);
  while (conds.length < want && pool.length) {
    const x = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    if (!used.has(x.f)) {
      used.add(x.f);
      conds.push(x);
    }
  }
  return { conds, invert: rand() < 0.5 ? a.invert : b.invert };
};

// Evolve rules on [WARMUP, trainEnd). Returns every evaluated rule (hall of fame).
export const evolveRules = ({ rand, nFeatures, ranksBySymbol, ctx, trainEnd, minTrades, exits, population = 240, generations = 14, log = () => {} }) => {
  const n = ctx.series[0].c.length;
  const hall = new Map();
  const fitness = (rule) => {
    const key = ruleKey(rule);
    if (hall.has(key)) return hall.get(key).fit;
    const sigs = ranksBySymbol.map((R) => ruleSignals(rule, R, n, trainEnd));
    const r = evalSigs(sigs, exits, ctx, WARMUP, trainEnd);
    const fit = r.trades < minTrades ? -999 : r.score + 5 * (r.breadth - 0.5) - 0.5 * rule.conds.length;
    hall.set(key, { rule, fit, train: { ret: r.ret, score: r.score, trades: r.trades, breadth: r.breadth } });
    return fit;
  };
  let pop = Array.from({ length: population }, () => randomRule(rand, nFeatures));
  for (let g = 0; g < generations; g++) {
    const scored = pop.map((rule) => ({ rule, fit: fitness(rule) })).sort((a, b) => b.fit - a.fit);
    log(`  thế hệ ${g + 1}/${generations}: tốt nhất fitness ${scored[0].fit.toFixed(1)} (đã thử ${hall.size} luật)`);
    const elite = scored.slice(0, Math.floor(population * 0.2)).map((x) => x.rule);
    const next = [...elite];
    while (next.length < population) {
      const roll = rand();
      if (roll < 0.55) next.push(mutateRule(rand, pick(rand, elite), nFeatures));
      else if (roll < 0.8) next.push(crossRules(rand, pick(rand, elite), pick(rand, elite)));
      else next.push(randomRule(rand, nFeatures));
    }
    pop = next;
  }
  return hall;
};
