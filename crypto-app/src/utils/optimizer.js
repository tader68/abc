
import { runBacktest } from './backtest';
import { fetchKlines } from '../services/api';

// Expanded Parameter Grid for Deep Dive
const PARAM_GRID = [];
const adxOptions = [20, 25, 30];
const rsiLowerOptions = [25, 30, 35];
const rsiUpperOptions = [65, 70, 75];
const tpMultOptions = [1.5, 2.0, 2.5, 3.0];
const slMultOptions = [1.0, 1.5, 2.0];

// Generate Grid
adxOptions.forEach(adx => {
    rsiLowerOptions.forEach(rsiL => {
        rsiUpperOptions.forEach(rsiU => {
            tpMultOptions.forEach(tp => {
                slMultOptions.forEach(sl => {
                    PARAM_GRID.push({
                        adxThreshold: adx,
                        rsiLower: rsiL,
                        rsiUpper: rsiU,
                        tpMult: tp,
                        slMult: sl
                    });
                });
            });
        });
    });
});

export const optimizeStrategy = async (coins) => {
    console.log(`Starting Deep Dive Optimization... Testing ${PARAM_GRID.length} combinations.`);

    // Top 5 Coins for Robustness
    const targetSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    const testCoins = coins.filter(c => targetSymbols.includes(c.symbol));

    if (testCoins.length === 0) {
        console.warn("Target coins not found. Using top 3 available.");
        testCoins.push(...coins.slice(0, 3));
    }

    // Fetch Data Once (1000 candles for significance)
    const marketData = {};
    for (const coin of testCoins) {
        console.log(`Fetching data for ${coin.symbol}...`);
        marketData[coin.symbol] = await fetchKlines(coin.symbol, '1h', 1000);
    }

    let results = [];

    // Grid Search
    for (let i = 0; i < PARAM_GRID.length; i++) {
        const params = PARAM_GRID[i];
        let totalPnL = 0;
        let totalWinRate = 0;
        let totalMaxDrawdown = 0;

        for (const coin of testCoins) {
            const klines = marketData[coin.symbol];
            if (klines && klines.length > 0) {
                const result = runBacktest(klines, params, coin.symbol);
                totalPnL += result.totalPnL;
                totalWinRate += result.winRate;
                totalMaxDrawdown += result.maxDrawdown;
            }
        }

        const avgPnL = totalPnL / testCoins.length;
        const avgWinRate = totalWinRate / testCoins.length;
        const avgMaxDrawdown = totalMaxDrawdown / testCoins.length;

        // Risk-Adjusted Score: Reward PnL, Heavily Penalize Drawdown
        // Score = PnL - (2 * MaxDD)
        // Example: PnL 20%, DD 5% => 20 - 10 = 10
        // Example: PnL 30%, DD 20% => 30 - 40 = -10 (Rejected)
        const score = avgPnL - (avgMaxDrawdown * 2);

        results.push({
            params,
            score,
            metrics: { pnl: avgPnL, winRate: avgWinRate, maxDD: avgMaxDrawdown }
        });

        // Progress Log every 50 iterations
        if (i % 50 === 0) console.log(`Processed ${i}/${PARAM_GRID.length}...`);
    }

    // Sort by Score (Descending)
    results.sort((a, b) => b.score - a.score);

    // Log Top 3
    console.log("--- TOP 3 PARAMETER SETS ---");
    results.slice(0, 3).forEach((res, idx) => {
        console.log(`#${idx + 1}: Score ${res.score.toFixed(2)} | PnL ${res.metrics.pnl.toFixed(1)}% | WR ${res.metrics.winRate.toFixed(1)}% | MaxDD ${res.metrics.maxDD.toFixed(1)}%`);
        console.log(`Params: ${JSON.stringify(res.params)}`);
    });

    const bestResult = results[0];
    console.log("Optimization Complete. Winner:", bestResult.params);
    return bestResult.params;
};
