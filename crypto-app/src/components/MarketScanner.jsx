
import React, { useState, useEffect } from 'react';
import { SUPPORTED_COINS, fetchCryptoPrice, fetchKlines } from '../services/api';
import { generateSignal } from '../utils/strategy';
import { sendTelegramMessage, formatSignalMessage } from '../services/telegram';

const MarketScanner = ({ onAutoTrade, isAutoTrading, onScanUpdate, news, isScalping, trades, strategyParams }) => {
    const [scanResults, setScanResults] = useState([]);
    const [scanning, setScanning] = useState(false);

    const tradesRef = React.useRef(trades);
    const newsRef = React.useRef(news);

    useEffect(() => {
        tradesRef.current = trades;
    }, [trades]);

    useEffect(() => {
        newsRef.current = news;
    }, [news]);

    const scanMarket = async () => {
        setScanning(true);
        const results = [];
        const primaryTimeframe = isScalping ? '15m' : '1h';
        const trendTimeframe = isScalping ? '1h' : '4h';

        const MAX_TRADES_PER_SCAN = 3;

        // Process in chunks
        let skippedCount = 0;
        for (const coin of SUPPORTED_COINS) {
            try {
                // 1. Universe Filter: Check Volume first
                const stats = await import('../services/api').then(m => m.fetch24hTicker(coin.symbol));

                // Filter: Min Volume $10M
                if (!stats || stats.quoteVolume < 10000000) {
                    skippedCount++;
                    continue;
                }

                const price = await fetchCryptoPrice(coin.symbol);
                const klinesPrimary = await fetchKlines(coin.symbol, primaryTimeframe);
                const klinesTrend = await fetchKlines(coin.symbol, trendTimeframe);

                if (price && klinesPrimary.length > 0) {
                    const signal = generateSignal(price, klinesPrimary, klinesTrend, strategyParams, newsRef.current, null, isScalping ? '15m' : '1H', coin.symbol, coin.name);
                    const result = { ...coin, price, signal, volume: stats.quoteVolume };
                    results.push(result);
                }
            } catch (e) {
                console.error(`Failed to scan ${coin.symbol}`, e);
            }
            await new Promise(r => setTimeout(r, 100)); // Faster scan (100ms)
        }
        console.log(`Scanner: Filtered out ${skippedCount} low-volume coins.`);

        // Sorting: Strong Signals -> Signals -> Neutral
        results.sort((a, b) => {
            const scoreA = Math.abs(a.signal.score || 0);
            const scoreB = Math.abs(b.signal.score || 0);
            return scoreB - scoreA; // Descending by absolute score strength
        });

        setScanResults(results);
        if (onScanUpdate) onScanUpdate(results);

        // BATCH EXECUTION: Trade the TOP strongest signals found
        if (isAutoTrading) {
            let executedCount = 0;
            for (const res of results) {
                if (executedCount >= MAX_TRADES_PER_SCAN) break;

                const { signal, symbol } = res;
                // Only consider LONG/SHORT signals with Score >= 4
                if ((signal.type === 'LONG' || signal.type === 'SHORT') && Math.abs(signal.score) >= 4) {
                    const isActive = tradesRef.current.some(t => t.symbol === symbol && t.status === 'OPEN');
                    if (!isActive) {
                        onAutoTrade({ ...signal, symbol, timestamp: Date.now() });
                        executedCount++;
                    }
                }
            }
        }

        setScanning(false);
    };

    useEffect(() => {
        scanMarket();
        const interval = setInterval(scanMarket, 60000);
        return () => clearInterval(interval);
    }, [isAutoTrading, isScalping]);

    return (
        <div className="scanner-container">
            <div className="scanner-header">
                <h2>Market Scanner ({SUPPORTED_COINS.length} Coins)</h2>
                <div className="scanner-status">
                    {scanning ? <span className="scanning-badge">Scanning...</span> : <span className="idle-badge">Idle</span>}
                </div>
            </div>

            <div className="scanner-table-wrapper">
                <table className="scanner-table">
                    <thead>
                        <tr>
                            <th>Coin</th>
                            <th>Price</th>
                            <th>Signal</th>
                            <th>Sentiment</th>
                            <th>RSI</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {scanResults.map((res) => (
                            <tr key={res.symbol} className={res.signal.type !== 'NEUTRAL' ? 'highlight-row' : ''}>
                                <td>{res.name} <span className="symbol-text">({res.symbol})</span></td>
                                <td>${res.price.toFixed(res.price < 1 ? 4 : 2)}</td>
                                <td className={`signal-text ${res.signal.type.toLowerCase()}`}>{res.signal.type}</td>
                                <td style={{ color: res.signal.indicators.sentiment > 0 ? 'var(--accent-green)' : res.signal.indicators.sentiment < 0 ? 'var(--accent-red)' : 'inherit' }}>
                                    {res.signal.indicators.sentiment > 0 ? '+' : ''}{res.signal.indicators.sentiment?.toFixed(1) || 0}
                                </td>
                                <td>{res.signal.indicators.rsi.toFixed(1)}</td>
                                <td>
                                    {res.signal.type !== 'NEUTRAL' && (
                                        <button
                                            className="mini-trade-btn"
                                            onClick={() => onAutoTrade({ ...res.signal, symbol: res.symbol, timestamp: Date.now(), isManual: true })}
                                        >
                                            Trade
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default MarketScanner;
