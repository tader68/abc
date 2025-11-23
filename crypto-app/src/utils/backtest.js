
import { generateSignal } from './strategy';

// Simulate trading on historical data
export const runBacktest = (klines, params, symbol) => {
    let balance = 10000; // Initial capital
    let trades = [];
    let activeTrade = null;
    let maxDrawdown = 0;
    let peakBalance = 10000;

    // We need enough data for indicators (e.g., 200 EMA)
    const START_INDEX = 200;

    for (let i = START_INDEX; i < klines.length; i++) {
        const currentPrice = klines[i].close;
        const currentKlines = klines.slice(0, i + 1);

        // 1. Check Active Trade
        if (activeTrade) {
            let closed = false;
            let pnl = 0;
            let reason = '';

            // Check TP/SL
            if (activeTrade.type === 'LONG') {
                if (currentPrice >= activeTrade.tp) {
                    pnl = (activeTrade.tp - activeTrade.entry) / activeTrade.entry * 100 * activeTrade.leverage;
                    closed = true;
                    reason = 'TP';
                } else if (currentPrice <= activeTrade.sl) {
                    pnl = (activeTrade.sl - activeTrade.entry) / activeTrade.entry * 100 * activeTrade.leverage;
                    closed = true;
                    reason = 'SL';
                }
            } else { // SHORT
                if (currentPrice <= activeTrade.tp) {
                    pnl = (activeTrade.entry - activeTrade.tp) / activeTrade.entry * 100 * activeTrade.leverage;
                    closed = true;
                    reason = 'TP';
                } else if (currentPrice >= activeTrade.sl) {
                    pnl = (activeTrade.entry - activeTrade.sl) / activeTrade.entry * 100 * activeTrade.leverage;
                    closed = true;
                    reason = 'SL';
                }
            }

            if (closed) {
                balance += (balance * (pnl / 100));
                trades.push({ ...activeTrade, exitPrice: currentPrice, pnl, reason, exitTime: klines[i].time });
                activeTrade = null;

                // Update Drawdown
                if (balance > peakBalance) peakBalance = balance;
                const drawdown = (peakBalance - balance) / peakBalance * 100;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            }
        }

        // 2. Look for New Trade (if no active trade)
        if (!activeTrade) {
            // Mock Trend Klines (just use same timeframe for simplicity in backtest or fetch if possible)
            // For speed, we'll assume trend alignment is neutral or use same klines
            const signal = generateSignal(currentPrice, currentKlines, currentKlines, params, [], null, '1H', symbol);

            if (Math.abs(signal.score) >= 4 && (signal.type === 'LONG' || signal.type === 'SHORT')) {
                activeTrade = {
                    type: signal.type,
                    entry: currentPrice,
                    tp: signal.tp,
                    sl: signal.sl,
                    leverage: signal.leverage,
                    startTime: klines[i].time
                };
            }
        }
    }

    const winRate = trades.filter(t => t.pnl > 0).length / trades.length * 100 || 0;
    const totalPnL = (balance - 10000) / 10000 * 100;

    return {
        symbol,
        tradesCount: trades.length,
        winRate,
        totalPnL,
        maxDrawdown,
        finalBalance: balance
    };
};
