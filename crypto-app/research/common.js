// Shared CLI helpers: argument parsing, default coin universe, market loading.
import { loadUniverse, syntheticSeries } from './data.js';

export const parseArgs = (argv) =>
  Object.fromEntries(
    argv
      .join(' ')
      .split(/--/)
      .filter(Boolean)
      .map((a) => {
        const [k, ...rest] = a.trim().split(/\s+/);
        return [k, rest.join(' ') || true];
      }),
  );

// 40 liquid USDT pairs listed on both Binance spot and USDT-M futures since before 2023
export const DEFAULT_UNIVERSE = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT',
  'TRXUSDT', 'DOTUSDT', 'BCHUSDT', 'ATOMUSDT', 'NEARUSDT', 'UNIUSDT', 'ETCUSDT', 'FILUSDT', 'APTUSDT', 'OPUSDT',
  'INJUSDT', 'AAVEUSDT', 'XLMUSDT', 'ALGOUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'GRTUSDT', 'HBARUSDT', 'VETUSDT',
  'ICPUSDT', 'THETAUSDT', 'CRVUSDT', 'SNXUSDT', 'COMPUSDT', 'ZECUSDT', 'DASHUSDT', 'XTZUSDT', 'CHZUSDT', 'ENJUSDT',
];

export const loadMarket = async (opt, market, log) => {
  if (opt.synthetic) {
    return opt.symbols.map((sym, i) => syntheticSeries(sym, opt.bars, opt.seed * 1000 + i, 0, opt.plant || {}));
  }
  return loadUniverse({ market, symbols: opt.symbols, interval: opt.interval, bars: opt.bars, derivs: !opt.noDerivs, log });
};
