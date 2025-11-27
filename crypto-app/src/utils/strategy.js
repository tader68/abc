// Helper: Calculate SMA
const calculateSMA = (data, period) => {
    const sma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            sma.push(null);
            continue;
        }
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += data[i - j];
        }
        sma.push(sum / period);
    }
    return sma;
};

// Helper: Calculate EMA
const calculateEMA = (data, period) => {
    const k = 2 / (period + 1);
    const ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
};

// Helper: Calculate Standard Deviation
const calculateStdDev = (data, period, sma) => {
    const stdDev = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            stdDev.push(null);
            continue;
        }
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += Math.pow(data[i - j] - sma[i], 2);
        }
        stdDev.push(Math.sqrt(sum / period));
    }
    return stdDev;
};

// Helper: Calculate True Range
const calculateTR = (high, low, close, prevClose) => {
    const hl = high - low;
    const hc = Math.abs(high - prevClose);
    const lc = Math.abs(low - prevClose);
    return Math.max(hl, hc, lc);
};

// RSI Calculation
const calculateRSI = (prices, period = 14) => {
    if (prices.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const difference = prices[i] - prices[i - 1];
        if (difference >= 0) gains += difference;
        else losses -= difference;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

// MACD Calculation
const calculateMACD = (prices) => {
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = calculateEMA(macdLine, 9);
    return {
        macd: macdLine[macdLine.length - 1],
        signal: signalLine[signalLine.length - 1],
        histogram: macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1]
    };
};

// Bollinger Bands
const calculateBB = (prices) => {
    const sma20 = calculateSMA(prices, 20);
    const stdDev = calculateStdDev(prices, 20, sma20);
    const lastSMA = sma20[sma20.length - 1];
    const lastStd = stdDev[stdDev.length - 1];
    return {
        upper: lastSMA + (lastStd * 2),
        middle: lastSMA,
        lower: lastSMA - (lastStd * 2)
    };
};

// Volume Analysis
const calculateVolumeAnalysis = (klines) => {
    const volumes = klines.map(k => k.volume);
    const currentVolume = volumes[volumes.length - 1];
    const avgVolume = volumes.slice(0, volumes.length - 1).reduce((a, b) => a + b, 0) / (volumes.length - 1);

    return {
        isSpike: currentVolume > avgVolume * 2,
        ratio: currentVolume / avgVolume
    };
};

// ATR Calculation
const calculateATR = (klines, period = 14) => {
    if (klines.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < klines.length; i++) {
        trs.push(calculateTR(klines[i].high, klines[i].low, klines[i].close, klines[i - 1].close));
    }
    // Simple SMA of TR for ATR
    let atr = 0;
    // Initial ATR
    for (let i = 0; i < period; i++) atr += trs[i];
    atr /= period;
    // Smoothing
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
};

// ADX Calculation (Simplified)
const calculateADX = (klines, period = 14) => {
    const closes = klines.map(k => k.close);
    const smaShort = calculateSMA(closes, 10);
    const smaLong = calculateSMA(closes, 30);

    const slope = (smaShort[smaShort.length - 1] - smaShort[smaShort.length - 5]) / 5;
    const strength = Math.min(100, Math.abs(slope) / closes[closes.length - 1] * 10000); // Normalized slope

    return strength; // 0-100 scale proxy
};

// Pivot Points (Standard)
const calculatePivotPoints = (high, low, close) => {
    const pp = (high + low + close) / 3;
    const r1 = 2 * pp - low;
    const s1 = 2 * pp - high;
    const r2 = pp + (high - low);
    const s2 = pp - (high - low);
    return { pp, r1, s1, r2, s2 };
};

// Ichimoku Cloud Calculation
const calculateIchimoku = (klines) => {
    if (klines.length < 52) return null;

    const getHighLow = (period, idx) => {
        let h = -Infinity, l = Infinity;
        for (let i = 0; i < period; i++) {
            if (idx - i < 0) break;
            h = Math.max(h, klines[idx - i].high);
            l = Math.min(l, klines[idx - i].low);
        }
        return { h, l };
    };

    const idx = klines.length - 1;

    // Tenkan-sen (Conversion Line): (9-period High + 9-period Low) / 2
    const tenkanHL = getHighLow(9, idx);
    const tenkan = (tenkanHL.h + tenkanHL.l) / 2;

    // Kijun-sen (Base Line): (26-period High + 26-period Low) / 2
    const kijunHL = getHighLow(26, idx);
    const kijun = (kijunHL.h + kijunHL.l) / 2;

    // Senkou Span A (Leading Span A): (Tenkan + Kijun) / 2
    const pastIdx = idx - 26;
    let spanA = null, spanB = null;

    if (pastIdx >= 0) {
        const tHL = getHighLow(9, pastIdx);
        const kHL = getHighLow(26, pastIdx);
        const t = (tHL.h + tHL.l) / 2;
        const k = (kHL.h + kHL.l) / 2;
        spanA = (t + k) / 2;

        // Senkou Span B (Leading Span B): (52-period High + 52-period Low) / 2
        const spanBHL = getHighLow(52, pastIdx);
        spanB = (spanBHL.h + spanBHL.l) / 2;
    }

    return { tenkan, kijun, spanA, spanB };
};

// Price Action Pattern Detection
const detectPatterns = (klines) => {
    const current = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    const patterns = [];

    const body = Math.abs(current.close - current.open);
    const upperShadow = current.high - Math.max(current.open, current.close);
    const lowerShadow = Math.min(current.open, current.close) - current.low;

    // Hammer / Pinbar (Bullish)
    if (lowerShadow > body * 2 && upperShadow < body * 0.5) {
        patterns.push('Hammer/Pinbar');
    }

    // Shooting Star (Bearish)
    if (upperShadow > body * 2 && lowerShadow < body * 0.5) {
        patterns.push('Shooting Star');
    }

    // Bullish Engulfing
    if (current.close > current.open && prev.close < prev.open &&
        current.close > prev.open && current.open < prev.close) {
        patterns.push('Bullish Engulfing');
    }

    // Bearish Engulfing
    if (current.close < current.open && prev.close > prev.open &&
        current.close < prev.open && current.open > prev.close) {
        patterns.push('Bearish Engulfing');
    }

    return patterns;
};

// Sentiment Analysis
const calculateSentiment = (news, symbol, coinName) => {
    if (!news || news.length === 0) return 0;

    let sentimentScore = 0;
    const bullishKeywords = ['break', 'surge', 'bull', 'high', 'approve', 'etf', 'record', 'upgrade', 'buy', 'greed'];
    const bearishKeywords = ['crash', 'drop', 'bear', 'low', 'ban', 'sec', 'hack', 'sell', 'fear', 'down'];

    const baseSymbol = symbol ? symbol.replace('USDT', '') : '';

    news.forEach(item => {
        const title = item.title.toLowerCase();
        const isSpecific = (coinName && title.includes(coinName.toLowerCase())) || (baseSymbol && title.includes(baseSymbol.toLowerCase()));
        const weight = isSpecific ? 3 : 1; // Triple weight for specific news

        bullishKeywords.forEach(word => {
            if (title.includes(word)) sentimentScore += (1 * weight);
        });
        bearishKeywords.forEach(word => {
            if (title.includes(word)) sentimentScore -= (1 * weight);
        });
    });

    // Normalize to range -2 to 2
    return Math.max(-2, Math.min(2, sentimentScore / 5)); // Divide by 5 to keep within range
};

// --- HELPER: TRENDING STRATEGY (ADX > 25) ---
const generateTrendingSignal = (context) => {
    const { currentPrice, bb, rsi, macd, adx, trendPrimary, trendHigher, volumeAnalysis, patterns, sentimentScore, params, timeframeLabel, higherTimeframeLabel } = context;

    let score = 0;
    let reasons = [];

    // 1. Multi-Timeframe Trend Filter (The "King")
    if (trendHigher.includes('UP')) {
        if (trendPrimary === 'UP') { score += 2; reasons.push(`MTF Alignment (${higherTimeframeLabel}+${timeframeLabel} Bull)`); }
        else { score -= 1; reasons.push(`Trend Conflict (${higherTimeframeLabel} Up, ${timeframeLabel} Down)`); }
    } else if (trendHigher.includes('DOWN')) {
        if (trendPrimary === 'DOWN') { score -= 2; reasons.push(`MTF Alignment (${higherTimeframeLabel}+${timeframeLabel} Bear)`); }
        else { score += 1; reasons.push(`Trend Conflict (${higherTimeframeLabel} Down, ${timeframeLabel} Up)`); }
    }

    // 2. Momentum Breakout (Capture Pumps)
    if (currentPrice > bb.upper && trendPrimary === 'UP') {
        score += 2;
        reasons.push("Momentum Breakout (Price > Upper BB)");
    }
    if (currentPrice < bb.lower && trendPrimary === 'DOWN') {
        score -= 2;
        reasons.push("Momentum Breakout (Price < Lower BB)");
    }

    // 3. RSI (Trend Mode - Ignore Overbought in Strong Trend)
    if (rsi < params.rsiLower) { score += 1; reasons.push(`RSI Oversold (<${params.rsiLower})`); }

    if (rsi > params.rsiUpper) {
        if (trendHigher === 'STRONG_UP') {
            score += 0.5; // Bullish in strong trend
            reasons.push(`RSI High (Strong Trend)`);
        } else {
            score -= 1;
            reasons.push(`RSI Overbought (>${params.rsiUpper})`);
        }
    }

    // 4. MACD
    if (macd.histogram > 0 && macd.macd > macd.signal) { score += 1; reasons.push("MACD Bull"); }
    if (macd.histogram < 0 && macd.macd < macd.signal) { score -= 1; reasons.push("MACD Bear"); }

    // 5. Volume
    if (volumeAnalysis.isSpike) {
        if (score > 0) { score += 1; reasons.push("Vol Spike"); }
        else if (score < 0) { score -= 1; reasons.push("Vol Spike"); }
    }

    // 6. Price Action
    if (patterns.includes('Bullish Engulfing') || patterns.includes('Hammer/Pinbar')) {
        score += 1.5; reasons.push(`Pattern: ${patterns.join(', ')}`);
    }
    if (patterns.includes('Bearish Engulfing') || patterns.includes('Shooting Star')) {
        score -= 1.5; reasons.push(`Pattern: ${patterns.join(', ')}`);
    }

    // 7. Sentiment
    if (sentimentScore !== 0) {
        score += sentimentScore * 0.5;
        reasons.push(`Sentiment (${sentimentScore > 0 ? '+' : ''}${sentimentScore.toFixed(1)})`);
    }

    // 8. TREND GUARD (Strict)
    if (trendHigher === 'STRONG_UP' && score < 0) {
        score = 0; reasons.push("Trend Guard: Blocked Short (Strong Uptrend)");
    }
    if (trendHigher === 'STRONG_DOWN' && score > 0) {
        score = 0; reasons.push("Trend Guard: Blocked Long (Strong Downtrend)");
    }

    return { score, reasons, type: score >= 3 ? 'LONG' : (score <= -3 ? 'SHORT' : 'NEUTRAL') };
};

// --- HELPER: RANGING STRATEGY (ADX <= 25) ---
const generateRangingSignal = (context) => {
    const { currentPrice, bb, rsi, macd, adx, trendHigher, volumeAnalysis, sentimentScore, params, atr } = context;

    let score = 0;
    let reasons = [];
    let type = 'NEUTRAL';
    let tp = 0, sl = 0;

    const slDistMR = atr * 1.5; // Tighter SL for mean reversion

    // 1. Mean Reversion Logic (BB Bounce)
    // LONG: Lower BB + RSI Oversold
    if (currentPrice <= bb.lower && rsi < 30) {
        // GUARD: Don't Long if Higher Timeframe is STRONG DOWN
        if (trendHigher !== 'STRONG_DOWN') {
            score = 3;
            type = 'LONG';
            reasons.push(`Mean Reversion: Lower BB Bounce (RSI ${rsi.toFixed(1)})`);
            tp = bb.middle;
            sl = currentPrice - slDistMR;
        } else {
            reasons.push("Blocked: Strong Downtrend");
        }
    }

    // SHORT: Upper BB + RSI Overbought
    else if (currentPrice >= bb.upper && rsi > 70) {
        // GUARD: Don't Short if Higher Timeframe is STRONG UP
        if (trendHigher !== 'STRONG_UP') {
            score = -3;
            type = 'SHORT';
            reasons.push(`Mean Reversion: Upper BB Bounce (RSI ${rsi.toFixed(1)})`);
            tp = bb.middle;
            sl = currentPrice + slDistMR;
        } else {
            reasons.push("Blocked: Strong Uptrend");
        }
    }
    else {
        reasons.push(`Sideway (ADX ${adx.toFixed(1)}). Waiting for Setup.`);
    }

    return { score, reasons, type, tp, sl };
};

export const generateSignal = (currentPrice, klinesPrimary, klinesTrend = [], params = { rsiLower: 30, rsiUpper: 70, tpMult: 4, slMult: 2 }, news = [], geminiSentiment = null, timeframeLabel = '1H', symbol = '', coinName = '') => {
    // Primary Data Analysis (1H or 15m)
    const closePrices = klinesPrimary.map(k => k.close);
    const rsi = calculateRSI(closePrices);
    const macd = calculateMACD(closePrices);
    const bb = calculateBB(closePrices);
    const ema50 = calculateEMA(closePrices, 50);
    const currentEMA50 = ema50[ema50.length - 1];
    const trendPrimary = currentPrice > currentEMA50 ? 'UP' : 'DOWN';

    // Quant Metrics
    const atr = calculateATR(klinesPrimary);
    const adx = calculateADX(klinesPrimary);
    const pivots = calculatePivotPoints(klinesPrimary[klinesPrimary.length - 1].high, klinesPrimary[klinesPrimary.length - 1].low, klinesPrimary[klinesPrimary.length - 1].close);
    const volumeAnalysis = calculateVolumeAnalysis(klinesPrimary);
    const patterns = detectPatterns(klinesPrimary);

    // Sentiment Analysis
    let sentimentScore = 0;
    let sentimentReason = "";

    if (geminiSentiment) {
        sentimentScore = geminiSentiment.score / 5;
        sentimentReason = `Gemini AI: ${geminiSentiment.reasoning}`;
    } else {
        sentimentScore = calculateSentiment(news, symbol, coinName);
        sentimentReason = sentimentScore > 0 ? "News AI: Bullish" : sentimentScore < 0 ? "News AI: Bearish" : "News: Neutral";
        if (Math.abs(sentimentScore) >= 1.5) sentimentReason += " (Strong)";
    }

    // Trend Data Analysis (4H or 1H)
    let trendHigher = 'NEUTRAL';
    let ichimokuHigher = null;
    const higherTimeframeLabel = timeframeLabel === '15m' ? '1H' : '4H';

    if (klinesTrend.length > 50) {
        const closePricesTrend = klinesTrend.map(k => k.close);
        const ema200 = calculateEMA(closePricesTrend, 200);
        const currentEMA200 = ema200[ema200.length - 1];
        ichimokuHigher = calculateIchimoku(klinesTrend);

        if (currentPrice > currentEMA200) {
            if (ichimokuHigher && ichimokuHigher.spanA !== null && ichimokuHigher.spanB !== null && currentPrice > Math.max(ichimokuHigher.spanA, ichimokuHigher.spanB)) {
                trendHigher = 'STRONG_UP';
            } else {
                trendHigher = 'UP';
            }
        } else {
            if (ichimokuHigher && ichimokuHigher.spanA !== null && ichimokuHigher.spanB !== null && currentPrice < Math.min(ichimokuHigher.spanA, ichimokuHigher.spanB)) {
                trendHigher = 'STRONG_DOWN';
            } else {
                trendHigher = 'DOWN';
            }
        }
    }

    // --- REGIME DETECTION & SIGNAL GENERATION ---
    const context = {
        currentPrice, bb, rsi, macd, adx, atr, trendPrimary, trendHigher, volumeAnalysis, patterns, sentimentScore, params, timeframeLabel, higherTimeframeLabel
    };

    let result;
    let strategyMode = "";

    if (adx > 25) {
        strategyMode = "TRENDING";
        result = generateTrendingSignal(context);
    } else {
        strategyMode = "RANGING";
        result = generateRangingSignal(context);
    }

    const { score, reasons, type } = result;

    // Common Output Structure
    let signal = {
        type: type,
        entry: currentPrice,
        tp: 0, sl: 0, leverage: 1,
        reason: `[${strategyMode}] ${reasons.join(', ')}`,
        score: score,
        indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, patterns, sentiment: sentimentScore }
    };

    // Calculate TP/SL/Leverage if Signal is Active
    if (type !== 'NEUTRAL') {
        // Dynamic Leverage
        const calculateLeverage = (s) => {
            const absScore = Math.abs(s);
            if (absScore >= 7) return 40;
            if (absScore >= 5) return 20;
            if (absScore >= 4) return 10;
            return 5;
        };
        const leverage = calculateLeverage(score);

        // TP/SL Calculation
        const slDist = atr * params.slMult;
        const tp2Dist = slDist * 2.0;

        // If Ranging Strategy provided specific TP/SL, use them. Otherwise calculate standard.
        if (result.tp && result.sl) {
            signal.tp = result.tp;
            signal.sl = result.sl;
            signal.tp1 = result.tp; // Simplified for ranging
            signal.tp2 = result.tp;
            signal.tp3 = result.tp;
        } else {
            // Standard Trend Following TP/SL
            if (type === 'LONG') {
                signal.tp = currentPrice + tp2Dist;
                signal.tp1 = currentPrice + (slDist * 1.0);
                signal.tp2 = currentPrice + tp2Dist;
                signal.tp3 = currentPrice + (slDist * 3.0);
                signal.sl = currentPrice - slDist;
            } else {
                signal.tp = currentPrice - tp2Dist;
                signal.tp1 = currentPrice - (slDist * 1.0);
                signal.tp2 = currentPrice - tp2Dist;
                signal.tp3 = currentPrice - (slDist * 3.0);
                signal.sl = currentPrice + slDist;
            }
        }
        signal.leverage = leverage;
        signal.reason = `${type} (${strategyMode}) Lev x${leverage}: ${reasons.join(', ')}`;
    }

    return signal;
};
