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
        // Use Gemini AI (Scale -10..10 to -2..2)
        sentimentScore = geminiSentiment.score / 5;
        sentimentReason = `Gemini AI: ${geminiSentiment.reasoning}`;
    } else {
        // Fallback to Keyword AI (Context Aware)
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
            // Check Cloud
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

    let score = 0;
    let reasons = [];

    // 0. Sentiment Impact (New AI Layer)
    if (sentimentScore !== 0) {
        score += sentimentScore * 0.5; // Max +1 or -1
        reasons.push(`${sentimentReason} (${sentimentScore > 0 ? '+' : ''}${sentimentScore.toFixed(1)})`);
    }

    // --- NEW: MEAN REVERSION STRATEGY (SIDEWAY MARKET) ---
    // Trigger if Trend Strength (ADX) is weak (< 25)
    if (adx < 25) {
        const slDistMR = atr * 1.5; // Tighter SL for mean reversion

        // LONG SETUP: Price touches Lower Band + RSI Oversold
        // GUARD: Don't Long if Higher Timeframe is STRONG DOWN
        if (currentPrice <= bb.lower && rsi < 30 && trendHigher !== 'STRONG_DOWN') {
            return {
                type: 'LONG',
                entry: currentPrice,
                tp: bb.middle, // Target is Mean (Middle Band)
                tp1: currentPrice + (bb.middle - currentPrice) * 0.5,
                tp2: bb.middle,
                tp3: bb.upper, // Moonshot target
                sl: currentPrice - slDistMR,
                leverage: 5, // Lower leverage for counter-trend
                reason: `Mean Reversion: Lower BB Bounce (RSI ${rsi.toFixed(1)})`,
                score: 3, // Moderate score
                indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, patterns, sentiment: sentimentScore }
            };
        }

        // SHORT SETUP: Price touches Upper Band + RSI Overbought
        // GUARD: Don't Short if Higher Timeframe is STRONG UP
        if (currentPrice >= bb.upper && rsi > 70 && trendHigher !== 'STRONG_UP') {
            return {
                type: 'SHORT',
                entry: currentPrice,
                tp: bb.middle, // Target is Mean (Middle Band)
                tp1: currentPrice - (currentPrice - bb.middle) * 0.5,
                tp2: bb.middle,
                tp3: bb.lower, // Moonshot target
                sl: currentPrice + slDistMR,
                leverage: 5, // Lower leverage for counter-trend
                reason: `Mean Reversion: Upper BB Bounce (RSI ${rsi.toFixed(1)})`,
                score: -3, // Moderate score
                indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, patterns, sentiment: sentimentScore }
            };
        }

        // If Sideway but no setup, return NEUTRAL immediately (Don't force Trend Following)
        return {
            type: 'NEUTRAL',
            entry: currentPrice,
            tp: 0, sl: 0, leverage: 1,
            reason: `Sideway Market (ADX ${adx.toFixed(1)}). Waiting for BB Bounce.`,
            indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, sentiment: sentimentScore }
        };
    }

    // --- EXISTING: TREND FOLLOWING STRATEGY (ADX >= 25) ---

    // 1. Multi-Timeframe Trend Filter (The "King")
    if (trendHigher.includes('UP')) {
        if (trendPrimary === 'UP') { score += 2; reasons.push(`MTF Alignment (${higherTimeframeLabel}+${timeframeLabel} Bull)`); }
        else { score -= 1; reasons.push(`Trend Conflict (${higherTimeframeLabel} Up, ${timeframeLabel} Down)`); }
    } else if (trendHigher.includes('DOWN')) {
        if (trendPrimary === 'DOWN') { score -= 2; reasons.push(`MTF Alignment (${higherTimeframeLabel}+${timeframeLabel} Bear)`); }
        else { score += 1; reasons.push(`Trend Conflict (${higherTimeframeLabel} Down, ${timeframeLabel} Up)`); }
    }

    // 2. ADX Filter (Handled by Regime Detection above)
    // if (adx < 20) { ... } -> Removed to allow Mean Reversion

    // 3. Price Action Triggers
    if (patterns.includes('Bullish Engulfing') || patterns.includes('Hammer/Pinbar')) {
        score += 1.5; reasons.push(`Pattern: ${patterns.join(', ')}`);
    }
    if (patterns.includes('Bearish Engulfing') || patterns.includes('Shooting Star')) {
        score -= 1.5; reasons.push(`Pattern: ${patterns.join(', ')}`);
    }

    // 4. Ichimoku Cloud (Higher Timeframe) Support/Resist
    if (ichimokuHigher && ichimokuHigher.spanA !== null && ichimokuHigher.spanB !== null) {
        if (currentPrice > ichimokuHigher.spanA && currentPrice > ichimokuHigher.spanB) {
            score += 1; reasons.push(`Above ${higherTimeframeLabel} Cloud`);
        } else if (currentPrice < ichimokuHigher.spanA && currentPrice < ichimokuHigher.spanB) {
            score -= 1; reasons.push(`Below ${higherTimeframeLabel} Cloud`);
        }
    }

    // 5. RSI & MACD (Momentum)
    if (rsi < params.rsiLower) { score += 1; reasons.push(`RSI Oversold (<${params.rsiLower})`); }

    // MODIFIED: Relax RSI Overbought penalty in Strong Uptrend
    if (rsi > params.rsiUpper) {
        if (trendHigher === 'STRONG_UP') {
            score += 0.5; // Actually bullish in a strong trend!
            reasons.push(`RSI High (Strong Trend)`);
        } else {
            score -= 1;
            reasons.push(`RSI Overbought (>${params.rsiUpper})`);
        }
    }

    if (macd.histogram > 0 && macd.macd > macd.signal) { score += 1; reasons.push("MACD Bull"); }
    if (macd.histogram < 0 && macd.macd < macd.signal) { score -= 1; reasons.push("MACD Bear"); }

    // 6. Volume
    if (volumeAnalysis.isSpike) {
        if (score > 0) { score += 1; reasons.push("Vol Spike"); }
        else if (score < 0) { score -= 1; reasons.push("Vol Spike"); }
    }

    // --- NEW: MOMENTUM BREAKOUT (CAPTURE PUMPS) ---
    // Trigger: Price breaks Upper BB + High ADX + Uptrend
    if (currentPrice > bb.upper && adx > 25 && trendPrimary === 'UP') {
        score += 2;
        reasons.push("Momentum Breakout (Price > Upper BB)");
    }

    // 7. TREND GUARD (The "Don't Fight the Fed" Rule)
    // Prevent Shorting in Strong Uptrend and Longing in Strong Downtrend
    if (trendHigher === 'STRONG_UP' && score < 0) {
        score = 0;
        reasons.push("Trend Guard: Blocked Short (Strong Uptrend)");
    }
    if (trendHigher === 'STRONG_DOWN' && score > 0) {
        score = 0;
        reasons.push("Trend Guard: Blocked Long (Strong Downtrend)");
    }

    // Thresholds
    let signal = {
        type: 'NEUTRAL',
        entry: currentPrice,
        tp: 0, sl: 0, leverage: 1,
        reason: "Waiting for Institutional Setup...",
        indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, patterns, sentiment: sentimentScore }
    };

    // Dynamic Leverage Calculation
    const calculateLeverage = (score) => {
        const absScore = Math.abs(score);
        if (absScore >= 7) return 40; // Extremely Strong
        if (absScore >= 5) return 20; // Very Strong
        if (absScore >= 4) return 10; // Strong
        return 5; // Moderate
    };

    const leverage = calculateLeverage(score);

    // Dynamic SL/TP (Multi-Level)
    const slDist = atr * params.slMult; // SL is usually 1.5x ATR

    // TP Levels based on Risk:Reward (1:1, 1:2, 1:3) - More realistic for day trading
    const tp1Dist = slDist * 1.0;
    const tp2Dist = slDist * 2.0;
    const tp3Dist = slDist * 3.0;

    if (score >= 3) {
        signal = {
            type: 'LONG',
            entry: currentPrice,
            tp: currentPrice + tp2Dist, // Main target is TP2 (1:2 R:R)
            tp1: currentPrice + tp1Dist,
            tp2: currentPrice + tp2Dist,
            tp3: currentPrice + tp3Dist,
            sl: currentPrice - slDist,
            leverage: leverage,
            reason: `BUY SIGNAL (Lev x${leverage}): ${reasons.join(', ')}`,
            score: score,
            indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, patterns, sentiment: sentimentScore }
        };
    } else if (score <= -3) {
        signal = {
            type: 'SHORT',
            entry: currentPrice,
            tp: currentPrice - tp2Dist, // Main target is TP2 (1:2 R:R)
            tp1: currentPrice - tp1Dist,
            tp2: currentPrice - tp2Dist,
            tp3: currentPrice - tp3Dist,
            sl: currentPrice + slDist,
            leverage: leverage,
            reason: `SELL SIGNAL (Lev x${leverage}): ${reasons.join(', ')}`,
            score: score,
            indicators: { rsi, macd, bb, volume: volumeAnalysis, trend: trendPrimary, adx, atr, trendHigher, patterns, sentiment: sentimentScore }
        };
    }

    return signal;
};
