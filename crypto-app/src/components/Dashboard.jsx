
import React, { useState, useEffect } from 'react';
import CandleChart from './CandleChart';
import NewsFeed from './NewsFeed';
import FearGreedGauge from './FearGreedGauge';
import TrendMeter from './TrendMeter';
import { fetchCryptoPrice, fetchKlines, SUPPORTED_COINS } from '../services/api';
import { generateSignal } from '../utils/strategy';
import { runBacktest } from '../utils/backtest';
import { optimizeStrategy } from '../utils/optimizer';
import { analyzeNewsWithGemini } from '../services/gemini';

const Dashboard = ({ onAddToPortfolio, news, globalMetrics, isAutoTrading, isScalping, trades, strategyParams, setStrategyParams, isOptimizing, onOptimize }) => {
    const [symbol, setSymbol] = useState('BTCUSDT');
    const [price, setPrice] = useState(null);
    const [klines, setKlines] = useState([]);
    const [signal, setSignal] = useState(null);
    const [backtestResults, setBacktestResults] = useState(null);
    const [isBacktesting, setIsBacktesting] = useState(false);

    // Gemini AI State
    const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
    const [geminiSentiment, setGeminiSentiment] = useState(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);

    // Save API Key
    const handleApiKeyChange = (e) => {
        const key = e.target.value;
        setApiKey(key);
        localStorage.setItem('gemini_api_key', key);
    };

    // Call Gemini when news updates or key changes
    useEffect(() => {
        const analyze = async () => {
            if (apiKey && news.length > 0) {
                setIsAnalyzing(true);
                const result = await analyzeNewsWithGemini(news, apiKey);
                if (result) {
                    setGeminiSentiment(result);
                }
                setIsAnalyzing(false);
            }
        };
        analyze();
    }, [news, apiKey]);

    useEffect(() => {
        const fetchData = async () => {
            const primaryTimeframe = isScalping ? '15m' : '1h';
            const trendTimeframe = isScalping ? '1h' : '4h';

            const currentPrice = await fetchCryptoPrice(symbol);
            const klinesPrimary = await fetchKlines(symbol, primaryTimeframe);
            const klinesTrend = await fetchKlines(symbol, trendTimeframe);

            setPrice(currentPrice);
            setKlines(klinesPrimary);

            if (currentPrice && klinesPrimary.length > 0) {
                // Pass Gemini Sentiment if available, otherwise undefined (strategy will fallback to keywords)
                const newSignal = generateSignal(currentPrice, klinesPrimary, klinesTrend, strategyParams, news, geminiSentiment, isScalping ? '15m' : '1H');
                setSignal(newSignal);

                // Auto-Trade Logic for Dashboard Coin
                if (isAutoTrading && (newSignal.type === 'LONG' || newSignal.type === 'SHORT')) {
                    const trade = {
                        id: Date.now(),
                        symbol,
                        type: newSignal.type,
                        entry: newSignal.entry,
                        tp: newSignal.tp,
                        sl: newSignal.sl,
                        leverage: newSignal.leverage,
                        status: 'OPEN',
                        pnl: 0,
                        timestamp: Date.now()
                    };
                    onAddToPortfolio(trade);
                }
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 10000); // Update every 10s
        return () => clearInterval(interval);
    }, [symbol, strategyParams, geminiSentiment, isAutoTrading, isScalping]);

    const handleTrade = () => {
        if (!signal) return;
        const trade = {
            id: Date.now(),
            symbol,
            type: signal.type,
            entry: signal.entry,
            tp: signal.tp,
            sl: signal.sl,
            leverage: signal.leverage,
            status: 'OPEN',
            pnl: 0,
            isManual: true
        };
        onAddToPortfolio(trade);
    };

    const handleBacktest = async () => {
        setIsBacktesting(true);
        // Fetch more data for backtest
        const historyKlines = await fetchKlines(symbol, '1h', 1000);
        if (historyKlines.length > 200) {
            const results = runBacktest(historyKlines, strategyParams);
            setBacktestResults(results);
        }
        setIsBacktesting(false);
    };

    const handleOptimize = async () => {
        if (onOptimize) {
            onOptimize();
        }
    };

    return (
        <div className="dashboard-container">
            <header className="header">
                <div className="logo-section">
                    <h1>ABC <span style={{ fontSize: '0.5em', color: 'var(--accent-blue)' }}>TERMINAL</span></h1>
                </div>

                <div className="global-metrics">
                    <button
                        onClick={handleBacktest}
                        disabled={isBacktesting || isOptimizing}
                        className="backtest-btn"
                        style={{
                            background: 'var(--bg-dark)',
                            border: '1px solid var(--text-secondary)',
                            color: 'var(--text-secondary)',
                            padding: '5px 15px',
                            borderRadius: '20px',
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        {isBacktesting ? 'Running...' : 'Backtest'}
                    </button>

                    <button
                        onClick={handleOptimize}
                        disabled={isBacktesting || isOptimizing}
                        className="optimize-btn"
                        style={{
                            background: 'linear-gradient(45deg, var(--accent-blue), #60a5fa)',
                            border: 'none',
                            color: 'white',
                            padding: '5px 15px',
                            borderRadius: '20px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            fontSize: '0.85rem',
                            boxShadow: '0 2px 10px rgba(59, 130, 246, 0.3)'
                        }}
                    >
                        {isOptimizing ? 'Optimizing...' : 'Auto-Optimize'}
                    </button>

                    <div className="btc-dom" style={{
                        background: 'rgba(255,255,255,0.05)',
                        padding: '5px 12px',
                        borderRadius: '8px',
                        fontSize: '0.85rem',
                        border: '1px solid var(--border-color)'
                    }}>
                        <span style={{ color: 'var(--text-secondary)', marginRight: '5px' }}>BTC Dom:</span>
                        <strong>{globalMetrics.btcDominance.toFixed(1)}%</strong>
                    </div>
                </div>

                <div className="controls">
                    <button
                        onClick={() => {
                            const token = prompt('Enter Telegram Bot Token:', localStorage.getItem('telegram_bot_token') || '');
                            if (token) {
                                localStorage.setItem('telegram_bot_token', token);
                                const chat = prompt('Enter Chat ID:', localStorage.getItem('telegram_chat_id') || '');
                                if (chat) {
                                    localStorage.setItem('telegram_chat_id', chat);
                                    alert('Telegram settings saved!');
                                }
                            }
                        }}
                        style={{
                            background: 'transparent',
                            border: '1px solid #0088cc',
                            color: '#0088cc',
                            padding: '6px 12px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px'
                        }}
                    >
                        <span>✈️</span> Config
                    </button>
                    <input
                        type="password"
                        placeholder="Gemini API Key"
                        value={apiKey}
                        onChange={handleApiKeyChange}
                        style={{
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid var(--border-color)',
                            color: 'white',
                            padding: '6px 10px',
                            borderRadius: '6px',
                            width: '120px',
                            fontSize: '0.9rem'
                        }}
                    />
                    <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="symbol-select">
                        {SUPPORTED_COINS.map(coin => (
                            <option key={coin.symbol} value={coin.symbol}>{coin.name} ({coin.symbol})</option>
                        ))}
                    </select>
                </div>
            </header >

            <div className="main-content-grid">
                <div className="chart-section">
                    <div className="price-display-compact">
                        <h2>{symbol}</h2>
                        <div className="price" style={{ color: signal?.type === 'LONG' ? 'var(--accent-green)' : signal?.type === 'SHORT' ? 'var(--accent-red)' : 'white' }}>
                            ${price ? price.toLocaleString() : '---'}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '5px' }}>
                            Data Source: <span style={{ color: '#FCD535' }}>Binance API</span> | Chart: TradingView Lib
                        </div>
                    </div>
                    {klines.length > 0 && <CandleChart data={klines} symbol={symbol} />}

                    {backtestResults && (
                        <div className="backtest-results" style={{ marginTop: '15px', padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', border: '1px solid var(--text-secondary)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                <h4 style={{ margin: 0, color: 'var(--accent-blue)' }}>AI Strategy Performance</h4>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                    Optimized Params: RSI {strategyParams.rsiLower}/{strategyParams.rsiUpper} | TP {strategyParams.tpMult}x | SL {strategyParams.slMult}x
                                </div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                                <div>Win Rate: <strong style={{ color: backtestResults.winRate > 50 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{backtestResults.winRate.toFixed(1)}%</strong></div>
                                <div>Total PnL: <strong style={{ color: backtestResults.totalReturn > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{backtestResults.totalReturn.toFixed(1)}%</strong></div>
                                <div>Trades: <strong>{backtestResults.totalTrades}</strong></div>
                                <div>Max DD: <strong style={{ color: 'var(--accent-red)' }}>{backtestResults.maxDrawdown.toFixed(1)}%</strong></div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="signal-section">
                    {/* Fear & Greed Gauge */}
                    <FearGreedGauge value={globalMetrics.fearGreedIndex} label={globalMetrics.fearGreedLabel} />

                    {signal ? (
                        <>
                            <div className={`signal-card ${signal.type.toLowerCase()}`}>
                                <h3>{signal.type}</h3>
                                <div className="signal-details">
                                    <div className="detail-item">
                                        <span>Entry</span>
                                        <strong>${signal.entry.toLocaleString()}</strong>
                                    </div>
                                    <div className="detail-item">
                                        <span>Lev</span>
                                        <strong>{signal.leverage}x</strong>
                                    </div>
                                    <div className="detail-item">
                                        <span>TP</span>
                                        <strong className="text-green">${signal.tp.toLocaleString()}</strong>
                                    </div>
                                    <div className="detail-item">
                                        <span>SL</span>
                                        <strong className="text-red">${signal.sl.toLocaleString()}</strong>
                                    </div>
                                    <div className="detail-item">
                                        <span>AI Sentiment</span>
                                        <strong style={{ color: signal.indicators.sentiment > 0 ? 'var(--accent-green)' : signal.indicators.sentiment < 0 ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
                                            {signal.indicators.sentiment > 0 ? '+' : ''}{signal.indicators.sentiment.toFixed(1)}
                                        </strong>
                                    </div>
                                </div>

                                <p className="reason">{signal.reason}</p>

                                {signal.type !== 'NEUTRAL' && (
                                    <button className="trade-btn" onClick={handleTrade}>
                                        Execute Trade
                                    </button>
                                )}
                            </div>

                            {/* Trend Meter */}
                            {signal.indicators.adx && (
                                <TrendMeter adx={signal.indicators.adx} trend={signal.indicators.trend} />
                            )}
                        </>
                    ) : (
                        <div className="signal-card">Loading analysis...</div>
                    )}
                </div>
            </div>

            <NewsFeed news={news} />
        </div >
    );
};

export default Dashboard;
