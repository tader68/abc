// Genetic programming: evolve NEW indicators as formulas over raw market series
// ("alpha mining"). Fitness is the information coefficient (correlation between the formula's
// z-scored value and the forward return), so no trading rules are involved at this stage.
import { sma, stdev } from './lib.js';

const nan = (n) => new Float64Array(n).fill(NaN);
const WINDOWS = [3, 5, 8, 13, 21, 34, 55];
const HORIZONS = [2, 6, 12];

// ---------- terminals: stationary series derived from OHLCV(+flow) ----------
export const terminals = (s) => {
  const n = s.c.length;
  const t = {};
  const mk = (f, from = 0) => {
    const out = nan(n);
    for (let i = from; i < n; i++) out[i] = f(i);
    return out;
  };
  t.ret = mk((i) => Math.log(s.c[i] / s.c[i - 1]), 1);
  t.rng = mk((i) => (s.h[i] - s.l[i]) / s.c[i]);
  t.body = mk((i) => (s.c[i] - s.o[i]) / s.c[i]);
  t.clv = mk((i) => (s.c[i] - s.l[i] - (s.h[i] - s.c[i])) / (s.h[i] - s.l[i] || NaN));
  t.gap = mk((i) => Math.log(s.o[i] / s.c[i - 1]), 1);
  t.lvol = mk((i) => Math.log(s.v[i] + 1));
  t.hl = mk((i) => Math.log(s.h[i] / s.l[i]));
  if (Array.isArray(s.tb)) t.tbr = mk((i) => s.tb[i] / (s.v[i] || NaN) - 0.5);
  if (Array.isArray(s.nt)) t.lnt = mk((i) => Math.log(s.nt[i] + 1));
  const ok = (k) => Array.isArray(s[k]) && s[k].some(Number.isFinite);
  if (ok('fundRate')) t.fr = mk((i) => s.fundRate[i] * 1e4);
  if (ok('oi')) t.doi = mk((i) => Math.log(s.oi[i] / s.oi[i - 1]), 1);
  if (ok('lsAll')) t.ls = mk((i) => Math.log(s.lsAll[i]));
  if (ok('lsTopPos')) t.lstop = mk((i) => Math.log(s.lsTopPos[i]));
  return t;
};

// ---------- operators ----------
const rolling = (x, w, f) => {
  const out = nan(x.length);
  for (let i = w - 1; i < x.length; i++) out[i] = f(i);
  return out;
};
const OPS = {
  // unary, windowed
  sma: { arity: 1, win: true, fn: (x, w) => Float64Array.from(sma(x, w)) },
  std: { arity: 1, win: true, fn: (x, w) => Float64Array.from(stdev(x, w, sma(x, w))) },
  delta: { arity: 1, win: true, fn: (x, w) => rolling(x, w + 1, (i) => x[i] - x[i - w]) },
  delay: { arity: 1, win: true, fn: (x, w) => rolling(x, w + 1, (i) => x[i - w]) },
  tsmax: { arity: 1, win: true, fn: (x, w) => rolling(x, w, (i) => { let m = -Infinity; for (let j = i - w + 1; j <= i; j++) if (x[j] > m) m = x[j]; return m; }) },
  tsmin: { arity: 1, win: true, fn: (x, w) => rolling(x, w, (i) => { let m = Infinity; for (let j = i - w + 1; j <= i; j++) if (x[j] < m) m = x[j]; return m; }) },
  zs: { arity: 1, win: true, fn: (x, w) => { const m = sma(x, w); const sd = stdev(x, w, m); return rolling(x, w, (i) => (x[i] - m[i]) / (sd[i] || NaN)); } },
  tsrank: { arity: 1, win: true, fn: (x, w) => rolling(x, w, (i) => { let k = 0; for (let j = i - w + 1; j < i; j++) if (x[j] < x[i]) k++; return k / (w - 1); }) },
  // unary
  neg: { arity: 1, fn: (x) => x.map((a) => -a) },
  abs: { arity: 1, fn: (x) => x.map(Math.abs) },
  sign: { arity: 1, fn: (x) => x.map(Math.sign) },
  // binary
  add: { arity: 2, fn: (x, y) => x.map((a, i) => a + y[i]) },
  sub: { arity: 2, fn: (x, y) => x.map((a, i) => a - y[i]) },
  mul: { arity: 2, fn: (x, y) => x.map((a, i) => a * y[i]) },
  div: { arity: 2, fn: (x, y) => x.map((a, i) => (Math.abs(y[i]) > 1e-12 ? a / y[i] : NaN)) },
  corr: {
    arity: 2,
    win: true,
    fn: (x, y, w) =>
      rolling(x, w, (i) => {
        let mx = 0;
        let my = 0;
        for (let j = i - w + 1; j <= i; j++) { mx += x[j]; my += y[j]; }
        mx /= w;
        my /= w;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let j = i - w + 1; j <= i; j++) {
          sxy += (x[j] - mx) * (y[j] - my);
          sxx += (x[j] - mx) ** 2;
          syy += (y[j] - my) ** 2;
        }
        return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
      }),
  },
};
const UNARY = Object.keys(OPS).filter((k) => OPS[k].arity === 1);
const BINARY = Object.keys(OPS).filter((k) => OPS[k].arity === 2);

// ---------- expression trees ----------
export const show = (e) => {
  if (e.term) return e.term;
  const w = e.w ? `,${e.w}` : '';
  return `${e.op}(${e.args.map(show).join(',')}${w})`;
};
const size = (e) => (e.term ? 1 : 1 + e.args.reduce((a, x) => a + size(x), 0));
const depthOf = (e) => (e.term ? 1 : 1 + Math.max(...e.args.map(depthOf)));

export const evaluateExpr = (e, T, memo = new Map()) => {
  if (e.term) return T[e.term];
  const key = show(e);
  if (memo.has(key)) return memo.get(key);
  const args = e.args.map((a) => evaluateExpr(a, T, memo));
  const out = OPS[e.op].fn(...args, e.w);
  memo.set(key, out);
  return out;
};

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const randomTree = (rand, names, depth) => {
  if (depth <= 1 || rand() < 0.25) return { term: pick(rand, names) };
  const op = rand() < 0.55 ? pick(rand, UNARY) : pick(rand, BINARY);
  const node = { op, args: [] };
  if (OPS[op].win) node.w = pick(rand, WINDOWS);
  for (let i = 0; i < OPS[op].arity; i++) node.args.push(randomTree(rand, names, depth - 1));
  return node;
};
const clone = (e) => JSON.parse(JSON.stringify(e));
const allNodes = (e, acc = []) => {
  acc.push(e);
  if (!e.term) e.args.forEach((a) => allNodes(a, acc));
  return acc;
};
const mutate = (rand, e, names) => {
  const c = clone(e);
  const nodes = allNodes(c);
  const target = pick(rand, nodes);
  const r = rand();
  if (r < 0.4) {
    const fresh = randomTree(rand, names, 3);
    Object.keys(target).forEach((k) => delete target[k]);
    Object.assign(target, fresh);
  } else if (target.term) target.term = pick(rand, names);
  else if (target.w && r < 0.8) target.w = pick(rand, WINDOWS);
  else {
    const op = pick(rand, target.args.length === 1 ? UNARY : BINARY);
    target.op = op;
    if (OPS[op].win) target.w = target.w || pick(rand, WINDOWS);
    else delete target.w;
  }
  return c;
};
const crossover = (rand, a, b) => {
  const c = clone(a);
  const donor = pick(rand, allNodes(clone(b)));
  const target = pick(rand, allNodes(c));
  Object.keys(target).forEach((k) => delete target[k]);
  Object.assign(target, donor);
  return c;
};

// ---------- fitness: information coefficient ----------
const corrRange = (x, y, from, to) => {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let i = from; i < to; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    n++;
    mx += x[i];
    my += y[i];
  }
  if (n < 200) return NaN;
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = from; i < to; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
};

// robust standardisation using only past data, clipped to ±3
export const standardise = (x, w = 200) => {
  const m = sma(x.map((a) => (Number.isFinite(a) ? a : NaN)), w);
  const sd = stdev(x, w, m);
  const out = nan(x.length);
  for (let i = 0; i < x.length; i++) {
    const z = (x[i] - m[i]) / (sd[i] || NaN);
    out[i] = Number.isFinite(z) ? Math.max(-3, Math.min(3, z)) : NaN;
  }
  return out;
};

const forwardReturns = (c, h) => {
  const out = nan(c.length);
  for (let i = 0; i + h < c.length; i++) out[i] = Math.log(c[i + h] / c[i]);
  return out;
};

// mean IC across symbols and horizons inside [from, to); only forward returns that end
// before `to` are used, so nothing from outside the range leaks in.
const scoreExpr = (expr, ctx, from, to) => {
  const memoFor = ctx.memos;
  let total = 0;
  let count = 0;
  let same = 0;
  let sign = 0;
  for (let si = 0; si < ctx.T.length; si++) {
    const z = standardise(evaluateExpr(expr, ctx.T[si], memoFor[si]));
    let sym = 0;
    let k = 0;
    for (const h of HORIZONS) {
      const ic = corrRange(z, ctx.fwd[si][h], from, to - h);
      if (Number.isFinite(ic)) {
        sym += ic;
        k++;
      }
    }
    if (!k) continue;
    sym /= k;
    total += sym;
    count++;
    const sg = Math.sign(sym);
    if (!sign) sign = sg;
    if (sg === sign) same++;
  }
  if (!count) return { ic: 0, consistency: 0 };
  return { ic: total / count, consistency: same / count };
};

export const makeGpContext = (seriesList) => {
  const T = seriesList.map(terminals);
  return {
    T,
    memos: seriesList.map(() => new Map()),
    fwd: seriesList.map((s) => Object.fromEntries(HORIZONS.map((h) => [h, forwardReturns(s.c, h)]))),
    names: Object.keys(T[0]).filter((k) => T.every((x) => x[k] && x[k].some(Number.isFinite))),
  };
};

// Evolve for `generations`, return the best distinct formulas by training fitness.
// Selection uses only [from, trainEnd); [trainEnd, valEnd) is used to drop formulas whose
// predictive sign does not persist. The hold-out is never touched.
export const evolveIndicators = (ctx, { rand, from, trainEnd, valEnd, population = 160, generations = 10, keep = 12, log = () => {} }) => {
  const fit = (e) => {
    if (size(e) > 14 || depthOf(e) > 5) return -1;
    const { ic, consistency } = scoreExpr(e, ctx, from, trainEnd);
    return Math.abs(ic) * consistency - 0.0008 * size(e);
  };
  let pop = Array.from({ length: population }, () => randomTree(rand, ctx.names, 4));
  const seen = new Map();
  for (let g = 0; g < generations; g++) {
    ctx.memos.forEach((m) => m.clear()); // bound memory: cache sub-expressions within a generation only
    const scored = pop.map((e) => {
      const key = show(e);
      if (!seen.has(key)) seen.set(key, { expr: e, fit: fit(e) });
      return seen.get(key);
    });
    scored.sort((a, b) => b.fit - a.fit);
    log(`  GP thế hệ ${g + 1}/${generations}: tốt nhất IC-fitness ${scored[0].fit.toFixed(4)}  ${show(scored[0].expr)}`);
    const elite = scored.slice(0, Math.floor(population * 0.2)).map((x) => x.expr);
    const next = [...elite];
    while (next.length < population) {
      const r = rand();
      if (r < 0.6) next.push(mutate(rand, pick(rand, elite), ctx.names));
      else if (r < 0.9) next.push(crossover(rand, pick(rand, elite), pick(rand, elite)));
      else next.push(randomTree(rand, ctx.names, 4));
    }
    pop = next;
  }
  ctx.memos.forEach((m) => m.clear());
  const ranked = [...seen.values()].filter((x) => x.fit > 0).sort((a, b) => b.fit - a.fit).slice(0, keep * 3);
  const out = [];
  for (const { expr, fit: f } of ranked) {
    const tr = scoreExpr(expr, ctx, from, trainEnd);
    const va = scoreExpr(expr, ctx, trainEnd, valEnd);
    if (Math.sign(va.ic) === Math.sign(tr.ic) && Math.abs(va.ic) >= 0.5 * Math.abs(tr.ic)) {
      out.push({ expr, text: show(expr), fit: f, trainIc: tr.ic, valIc: va.ic });
    }
    if (out.length >= keep) break;
  }
  return out;
};

// z-scored series of an evolved indicator for one symbol (feature to feed the rule miner)
export const indicatorSeries = (expr, s) => standardise(evaluateExpr(expr, terminals(s)));
