
import { generateSignal } from './strategy';

// Helper: Aggregate 1H klines to 4H
const aggregateKlines = (klines1h, timeframeH = 4) => {
    const klines4h = [];
    let current4h = null;

    for (let i = 0; i < klines1h.length; i++) {
        const k = klines1h[i];
        const date = new Date(k.time);

        // Check if this candle starts a new 4H block (00:00, 04:00, 08:00, etc.)
        // Assuming data is 1H and continuous. A simpler way is grouping by 4.
        // But checking hours is safer for real timestamps.
        const isNewBlock = date.getHours() % timeframeH === 0;

        if (isNewBlock || !current4h) {
            if (current4h) klines4h.push(current4h); // Push finished candle
            current4h = {
                time: k.time,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume
            };
        } else {
            // Update current 4H candle
            current4h.high = Math.max(current4h.high, k.high);
            current4h.low = Math.min(current4h.low, k.low);
            current4h.close = k.close;
            current4h.volume += k.volume;
        }
    }
    if (current4h) klines4h.push(current4h); // Push last candle
    return klines4h;
};

// Simulate trading on historical data
export const runBacktest = (klines, params, symbol) => {
    let balance = 10000; // Initial capital
    let trades = [];
    let activeTrade = null;
    let maxDrawdown = 0;
    let peakBalance = 10000;

    // Pre-calculate 4H Trend Data
    const klines4h = aggregateKlines(klines, 4);

    // We need enough data for indicators (e.g., 200 EMA)
    const START_INDEX = 200;

    for (let i = START_INDEX; i < klines.length; i++) {
        const currentKline = klines[i];
        const currentPrice = currentKline.close;
        const currentKlines = klines.slice(0, i + 1);

        // Filter 4H klines that have CLOSED before this current time
        // This prevents "looking into the future"
        const currentTrendKlines = klines4h.filter(k => k.time < currentKline.time);

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
            // Pass BOTH Primary (1H) and Trend (4H) data
            const signal = generateSignal(
                currentPrice,
                currentKlines,
                currentTrendKlines,
                params,
                [],
                null,
                '1H',
                symbol
            );

            // Use Score >= 3 to match Live Bot (was 4)
            if (Math.abs(signal.score) >= 3 && (signal.type === 'LONG' || signal.type === 'SHORT')) {
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
