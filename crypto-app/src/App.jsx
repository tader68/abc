
import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import Portfolio from './components/Portfolio';
import MarketScanner from './components/MarketScanner';
import { sendTelegramMessage, formatSignalMessage } from './services/telegram';
import './App.css';

function App() {
  // Data Versioning to handle breaking changes (like coin list updates)
  const DATA_VERSION = '1.1';

  const [trades, setTrades] = useState([]); // Initialize as empty, data will be loaded in useEffect

  const [isAutoTrading, setIsAutoTrading] = useState(() => {
    const saved = localStorage.getItem('abc_auto_trading');
    return saved === 'true';
  });
  const [isScalping, setIsScalping] = useState(() => {
    const saved = localStorage.getItem('abc_scalping');
    return saved === 'true';
  });
  const [marketData, setMarketData] = useState({}); // Map: symbol -> price
  const [news, setNews] = useState([]);
  const [globalMetrics, setGlobalMetrics] = useState({ fearGreedIndex: 50, fearGreedLabel: 'Neutral', btcDominance: 50 });

  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // Effect to handle data versioning and initial trade loading
  useEffect(() => {
    const storedVersion = localStorage.getItem('app_version');
    let currentTrades = [];

    if (storedVersion !== DATA_VERSION) {
      console.log('New version detected or no version found. Clearing stale data...');
      localStorage.removeItem('abc_trades'); // Clear old trades
      localStorage.setItem('app_version', DATA_VERSION);
      // Trades are already [] from useState, no need to set again immediately
    } else {
      // Version matches, attempt to load existing trades
      const saved = localStorage.getItem('abc_trades');
      currentTrades = saved ? JSON.parse(saved) : [];
    }

    // Cleanup: Remove duplicate active trades for the same symbol
    const uniqueTrades = [];
    const seenActive = new Set();

    // Sort by ID (timestamp) ascending to keep the OLDEST trade if duplicates exist
    currentTrades.sort((a, b) => a.id - b.id);

    for (const trade of currentTrades) {
      if (!trade.status || trade.status === 'OPEN') { // If trade is OPEN
        if (seenActive.has(trade.symbol)) continue; // Skip duplicate
        seenActive.add(trade.symbol);
      }
      uniqueTrades.push(trade);
    }

    // Restore original order (Newest First) for UI if needed, or just set it
    // The UI sorts it anyway.
    setTrades(uniqueTrades.reverse());
    setIsDataLoaded(true);
  }, []);



  const tradesRef = React.useRef(trades);

  useEffect(() => {
    if (isDataLoaded) {
      tradesRef.current = trades;
      localStorage.setItem('abc_trades', JSON.stringify(trades));
    }
  }, [trades, isDataLoaded]);

  useEffect(() => {
    localStorage.setItem('abc_auto_trading', isAutoTrading);
  }, [isAutoTrading]);

  useEffect(() => {
    localStorage.setItem('abc_scalping', isScalping);
  }, [isScalping]);

  // Fetch News and Global Metrics
  useEffect(() => {
    const fetchInfo = async () => {
      const newsData = await import('./services/api').then(m => m.fetchCryptoNews());
      const metricsData = await import('./services/api').then(m => m.fetchGlobalMetrics());
      setNews(newsData);
      setGlobalMetrics(metricsData);
    };
    fetchInfo();
    const interval = setInterval(fetchInfo, 60000 * 5); // Refresh every 5 mins
    return () => clearInterval(interval);
  }, []);

  // Real-time Price Updater for Active Trades
  useEffect(() => {
    if (!isDataLoaded) return;
    const updatePrices = async () => {
      const activeSymbols = [...new Set(trades.filter(t => t.status === 'OPEN').map(t => t.symbol))];
      if (activeSymbols.length === 0) return;

      const newPrices = {};
      await Promise.all(activeSymbols.map(async (symbol) => {
        const price = await import('./services/api').then(m => m.fetchCryptoPrice(symbol));
        if (price) newPrices[symbol] = price;
      }));

      setMarketData(prev => ({ ...prev, ...newPrices }));
    };

    const priceInterval = setInterval(updatePrices, 3000); // Update every 3 seconds
    return () => clearInterval(priceInterval);
  }, [trades, isDataLoaded]);

  // AI STRATEGY OPTIMIZER (Self-Learning)
  const [strategyParams, setStrategyParams] = useState({ rsiLower: 30, rsiUpper: 70, tpMult: 2, slMult: 1.5 });
  const [isOptimizing, setIsOptimizing] = useState(false);

  const runOptimization = async () => {
    if (isOptimizing) return;
    setIsOptimizing(true);
    try {
      const { optimizeStrategy } = await import('./utils/optimizer');
      const { SUPPORTED_COINS } = await import('./services/api');
      // Run optimization in background
      console.log("Starting Background Optimization...");
      const bestParams = await optimizeStrategy(SUPPORTED_COINS);
      setStrategyParams(bestParams);
      console.log("Strategy Updated with Best Params:", bestParams);
    } catch (e) {
      console.error("Optimization Failed:", e);
    } finally {
      setIsOptimizing(false);
    }
  };

  useEffect(() => {
    // Run once on startup
    runOptimization();
  }, []);

  const handleAddToPortfolio = (trade) => {
    if (!isDataLoaded) return; // Safety check
    const currentTrades = tradesRef.current;

    // 1. Check for Duplicate Active Trade (Synchronous Check)
    // Skip check if it's a manual trade
    if (!trade.isManual) {
      const hasActive = currentTrades.some(t => t.symbol === trade.symbol && t.status === 'OPEN');
      if (hasActive) {
        // console.log(`Trade for ${trade.symbol} already active. Skipped.`);
        return;
      }

      // 2. Check Daily Limit (Max 10 trades per day) - Only for Auto
      const today = new Date().toDateString();
      const tradesToday = currentTrades.filter(t => new Date(t.timestamp).toDateString() === today && !t.isManual).length;

      if (tradesToday >= 10) {
        // SMART ROTATION LOGIC
        // Find the "weakest" active trade to replace
        const activeAutoTrades = currentTrades.filter(t => t.status === 'OPEN' && !t.isManual);

        if (activeAutoTrades.length > 0) {
          // Calculate PnL for each active trade to find the worst one
          const tradesWithPnl = activeAutoTrades.map(t => {
            const currentPrice = marketData[t.symbol];
            if (!currentPrice) return { ...t, currentPnl: 0 };

            let pnl = 0;
            if (t.type === 'LONG') {
              pnl = (currentPrice - t.entry) / t.entry * 100 * t.leverage;
            } else {
              pnl = (t.entry - currentPrice) / t.entry * 100 * t.leverage;
            }
            return { ...t, currentPnl: pnl };
          });

          // Sort by PnL (Lowest first)
          tradesWithPnl.sort((a, b) => a.currentPnl - b.currentPnl);
          const worstTrade = tradesWithPnl[0];

          // Close the worst trade
          console.log(`Smart Rotation: Closing ${worstTrade.symbol} (PnL: ${worstTrade.currentPnl.toFixed(2)}%) to open ${trade.symbol}`);

          // Update state to close the old trade
          // We need to update tradesRef AND state to ensure consistency before adding new trade
          const closedTrade = { ...worstTrade, status: 'ROTATED_OUT', closeTime: Date.now(), pnl: worstTrade.currentPnl };

          // Update the local currentTrades array so the next step uses the updated list
          const tradeIndex = currentTrades.findIndex(t => t.id === worstTrade.id);
          if (tradeIndex !== -1) {
            currentTrades[tradeIndex] = closedTrade;
          }

          // Send Telegram Notification for Rotation
          const botToken = localStorage.getItem('telegram_bot_token');
          const chatId = localStorage.getItem('telegram_chat_id');
          if (botToken && chatId) {
            const msg = `🔄 *SMART ROTATION*\n` +
              `Closing Weakest Trade: *${worstTrade.symbol}*\n` +
              `PnL: ${worstTrade.currentPnl.toFixed(2)}%\n` +
              `Reason: Freeing slot for *${trade.symbol}*`;
            sendTelegramMessage(botToken, chatId, msg);
          }
        } else {
          console.log("Daily limit reached and no active trades to rotate. Trade skipped.");
          return;
        }
      }
    }

    // 3. Execute Trade
    // Update Ref immediately to block race conditions
    const newTrade = { ...trade, id: Date.now() + Math.random(), status: 'OPEN' }; // Ensure unique ID and OPEN status
    tradesRef.current = [newTrade, ...currentTrades];
    setTrades(prev => [newTrade, ...prev]);

    // 4. Send Telegram Notification
    const botToken = localStorage.getItem('telegram_bot_token');
    const chatId = localStorage.getItem('telegram_chat_id');
    if (botToken && chatId) {
      const signalForMsg = {
        type: trade.type,
        entry: trade.entry,
        tp: trade.tp,
        tp1: trade.tp1,
        tp2: trade.tp2,
        tp3: trade.tp3,
        sl: trade.sl,
        leverage: trade.leverage,
        reason: trade.reason || 'Auto-Trade Execution',
        indicators: trade.indicators || { sentiment: 0 }
      };
      const msg = formatSignalMessage(signalForMsg, trade.symbol, isScalping ? '15m' : '1H');
      sendTelegramMessage(botToken, chatId, msg);
    }
  };

  const handleCloseTrade = (id, status, pnl = 0) => {
    setTrades(prev => prev.map(t => t.id === id ? { ...t, status, pnl: pnl || 0 } : t));
  };

  const handleUpdateTrade = (id, updates) => {
    setTrades(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const handlePartialClose = (id, stage, pnlPercent, updates = {}) => {
    setTrades(prev => {
      const originalTrade = prev.find(t => t.id === id);
      if (!originalTrade) return prev;

      // 1. Create the Closed Portion Record
      const closedPortion = {
        ...originalTrade,
        id: Date.now() + Math.random(), // New unique ID
        status: stage, // 'TP1', 'TP2'
        pnl: pnlPercent,
        closeTime: Date.now(),
        isPartial: true,
        originalTradeId: id
      };

      // 2. Update the Original Trade (mark TP hit, move SL, etc.)
      return [
        closedPortion,
        ...prev.map(t => t.id === id ? { ...t, ...updates } : t)
      ];
    });
  };

  const handleScanUpdate = (results) => {
    // Update market data map
    const newMarketData = { ...marketData };
    results.forEach(r => {
      newMarketData[r.symbol] = r.price;
    });
    setMarketData(newMarketData);
  };

  const handleTestTelegram = () => {
    const botToken = localStorage.getItem('telegram_bot_token');
    const chatId = localStorage.getItem('telegram_chat_id');
    if (!botToken || !chatId) {
      alert('Please configure Telegram settings first!');
      return;
    }

    const mockSignal = {
      type: 'LONG',
      entry: 95000,
      tp: 98000,
      tp1: 96000,
      tp2: 97000,
      tp3: 98000,
      sl: 94000,
      leverage: 20,
      reason: 'Manual Test Signal',
      indicators: { sentiment: 0.8, adx: 25 }
    };

    const msg = formatSignalMessage(mockSignal, 'BTCUSDT', '15m');
    sendTelegramMessage(botToken, chatId, msg);
    alert('Test message sent!');
  };

  const handleClearData = () => {
    if (window.confirm('Are you sure you want to delete all trades and reset?')) {
      setTrades([]);
      localStorage.removeItem('abc_trades');
      window.location.reload();
    }
  };

  return (
    <div className="app-container">
      <div className="main-column">
        <div className="app-header">
          <div className="header-controls" style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'center' }}>
            <div className="control-group" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={isAutoTrading}
                  onChange={(e) => setIsAutoTrading(e.target.checked)}
                />
                <span className="slider round"></span>
              </label>
              <span className="toggle-label">Auto-Trading: <strong>{isAutoTrading ? 'ON' : 'OFF'}</strong></span>
            </div>

            <div className="control-group" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={isScalping}
                  onChange={(e) => setIsScalping(e.target.checked)}
                />
                <span className="slider round"></span>
              </label>
              <span className="toggle-label">Mode: <strong>{isScalping ? 'SCALPING (15m)' : 'SWING (1H)'}</strong></span>
            </div>

            <div className="control-group" style={{ display: 'flex', gap: '10px' }}>
              <button onClick={handleTestTelegram} style={{ background: '#2196F3', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                Test Telegram
              </button>
              <button onClick={handleClearData} style={{ background: 'var(--accent-red)', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                Reset Data
              </button>
            </div>
          </div>
        </div>

        <Dashboard
          onAddToPortfolio={handleAddToPortfolio}
          news={news}
          globalMetrics={globalMetrics}
          isAutoTrading={isAutoTrading}
          isScalping={isScalping}
          trades={trades}
          strategyParams={strategyParams}
          setStrategyParams={setStrategyParams}
          isOptimizing={isOptimizing}
          onOptimize={runOptimization}
        />

        {isDataLoaded && (
          <MarketScanner
            onAutoTrade={handleAddToPortfolio}
            isAutoTrading={isAutoTrading}
            onScanUpdate={handleScanUpdate}
            news={news}
            isScalping={isScalping}
            trades={trades}
          />
        )}
      </div>

      <div className="sidebar-column">
        <Portfolio
          trades={trades}
          onCloseTrade={handleCloseTrade}
          onUpdateTrade={handleUpdateTrade}
          onPartialClose={handlePartialClose}
          marketData={marketData}
        />
      </div>
    </div>
  );
}

export default App;
