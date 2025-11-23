
import { runBacktest } from './backtest';
import { fetchKlines } from '../services/api';

// Parameter Grid to Search
const PARAM_GRID = [
    { rsiLower: 30, rsiUpper: 70, tpMult: 2, slMult: 1.5 }, // Default
    { rsiLower: 25, rsiUpper: 75, tpMult: 2, slMult: 1.5 }, // Wider RSI
    { rsiLower: 30, rsiUpper: 70, tpMult: 1.5, slMult: 1.0 }, // Tighter Stops
    { rsiLower: 30, rsiUpper: 70, tpMult: 3, slMult: 2.0 }, // Wider Targets
    { rsiLower: 35, rsiUpper: 65, tpMult: 1.5, slMult: 1.0 }, // Aggressive Entry
];

export const optimizeStrategy = async (coins) => {
    console.log("Starting AI Strategy Optimization...");
    let bestParams = PARAM_GRID[0];
    let bestScore = -Infinity;

    // We optimize based on a subset of coins to save time/API calls, or all if possible
    // For demo, let's pick top 3 coins to optimize against
    const testCoins = coins.slice(0, 3);

    // Fetch Data Once
    const marketData = {};
    for (const coin of testCoins) {
        marketData[coin.symbol] = await fetchKlines(coin.symbol, '1h', 500);
    }

    // Grid Search
    for (const params of PARAM_GRID) {
        let totalPnL = 0;
        let totalWinRate = 0;

        for (const coin of testCoins) {
            const klines = marketData[coin.symbol];
            if (klines.length > 0) {
                const result = runBacktest(klines, params, coin.symbol);
                totalPnL += result.totalPnL;
                totalWinRate += result.winRate;
            }
        }

        // Scoring Algorithm: PnL has higher weight, but Win Rate matters too
        const avgPnL = totalPnL / testCoins.length;
        const avgWinRate = totalWinRate / testCoins.length;
        const score = avgPnL * 0.7 + avgWinRate * 0.3;

        console.log(`Params: ${JSON.stringify(params)} -> Score: ${score.toFixed(2)} (PnL: ${avgPnL.toFixed(1)}%, WR: ${avgWinRate.toFixed(1)}%)`);

        if (score > bestScore) {
            bestScore = score;
            bestParams = params;
        }
    }

    console.log("Optimization Complete. Best Params:", bestParams);
    return bestParams;
};
