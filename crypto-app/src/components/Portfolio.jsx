import React, { useState, useEffect } from 'react';

const Portfolio = ({ trades, onCloseTrade, onUpdateTrade, onPartialClose, marketData }) => {

    const calculatePnL = (trade) => {
        const currentPrice = marketData[trade.symbol];
        if (!currentPrice) return null;

        let pnlPercent = 0;
        if (trade.type === 'LONG') {
            pnlPercent = ((currentPrice - trade.entry) / trade.entry) * trade.leverage * 100;
        } else {
            pnlPercent = ((trade.entry - currentPrice) / trade.entry) * trade.leverage * 100;
        }
        return pnlPercent;
    };

    // Account Settings
    const INITIAL_BALANCE = 10000;
    const TRADE_SIZE = 1000; // $1000 per trade

    // Calculate Realized PnL from closed trades AND partial closes
    const realizedPnL = trades.reduce((acc, trade) => {
        // Include standard closes (WIN/LOSS) and partial closes (TP1/TP2)
        if (['WIN', 'LOSS', 'TP1', 'TP2', 'TP3', 'SL'].includes(trade.status)) {
            // For partials, we need to know the size portion.
            // TP1 = 50% size, TP2 = 30% size, TP3 = 20% size (if it was the final close)
            // But wait, the 'pnl' stored in the trade is the % change.
            // We need to apply the correct size multiplier.

            let sizeMultiplier = 1.0;
            if (trade.status === 'TP1') sizeMultiplier = 0.5;
            if (trade.status === 'TP2') sizeMultiplier = 0.3;
            if (trade.status === 'TP3') sizeMultiplier = 0.2; // Assuming TP3 closes the rest

            // If it's a full close (WIN/LOSS/SL), we need to check if it was a remaining portion
            // This is tricky with the current data structure.
            // Simplified: If it's a partial record, use fixed multipliers. 
            // If it's the main record closing, we check its history? 
            // Actually, the main record updates its 'tp1Hit' etc.
            // So if a main record closes as 'TP3' or 'SL', we check its flags.

            if (!trade.isPartial) {
                // This is the main trade closing
                if (trade.tp2Hit) sizeMultiplier = 0.2;
                else if (trade.tp1Hit) sizeMultiplier = 0.5;
            }

            return acc + ((trade.pnl / 100 * TRADE_SIZE) * sizeMultiplier);
        }
        return acc;
    }, 0);

    // Calculate Unrealized PnL (from open trades, based on REMAINING size)
    const unrealizedPnL = trades.reduce((acc, trade) => {
        if (!trade.status || trade.status === 'OPEN') {
            const pnlPercent = calculatePnL(trade);
            if (pnlPercent != null) {
                // Determine remaining size percentage
                let remainingSizePercent = 1.0;
                if (trade.tp2Hit) remainingSizePercent = 0.2; // 20% left
                else if (trade.tp1Hit) remainingSizePercent = 0.5; // 50% left

                return acc + ((pnlPercent / 100 * TRADE_SIZE) * remainingSizePercent);
            }
        }
        return acc;
    }, 0);

    const totalAccountPnL = realizedPnL + unrealizedPnL;
    const currentBalance = INITIAL_BALANCE + totalAccountPnL;
    const accountGrowthPercent = (totalAccountPnL / INITIAL_BALANCE) * 100;

    // Auto-Take Profit & Stop Loss Logic (Smart TP)
    useEffect(() => {
        trades.forEach((trade) => {
            if (!trade.status || trade.status === 'OPEN') {
                const currentPrice = marketData[trade.symbol];
                if (!currentPrice) return;

                const pnlPercent = calculatePnL(trade);

                if (trade.type === 'LONG') {
                    // TP1: Hit if Price reaches TP1 OR PnL >= 10%
                    if (!trade.tp1Hit && (pnlPercent >= 10 || (trade.tp1 && currentPrice >= trade.tp1))) {
                        onPartialClose(trade.id, 'TP1', pnlPercent, {
                            tp1Hit: true,
                            sl: trade.entry // Move SL to Entry
                        });
                    }
                    // TP2: Hit if Price reaches TP2
                    else if (!trade.tp2Hit && trade.tp2 && currentPrice >= trade.tp2) {
                        onPartialClose(trade.id, 'TP2', pnlPercent, {
                            tp2Hit: true
                        });
                    }
                    // TP3: Hit if Price reaches TP3
                    else if (currentPrice >= (trade.tp3 || trade.tp)) {
                        onCloseTrade(trade.id, 'TP3', pnlPercent);
                    }
                    // SL: Hit if Price hits SL
                    else if (currentPrice <= trade.sl) {
                        onCloseTrade(trade.id, 'SL', pnlPercent);
                    }
                } else { // SHORT
                    // TP1: Hit if Price reaches TP1 OR PnL >= 10%
                    if (!trade.tp1Hit && (pnlPercent >= 10 || (trade.tp1 && currentPrice <= trade.tp1))) {
                        onPartialClose(trade.id, 'TP1', pnlPercent, {
                            tp1Hit: true,
                            sl: trade.entry // Move SL to Entry
                        });
                    }
                    // TP2: Hit if Price reaches TP2
                    else if (!trade.tp2Hit && trade.tp2 && currentPrice <= trade.tp2) {
                        onPartialClose(trade.id, 'TP2', pnlPercent, {
                            tp2Hit: true
                        });
                    }
                    // TP3: Hit if Price reaches TP3
                    else if (currentPrice <= (trade.tp3 || trade.tp)) {
                        onCloseTrade(trade.id, 'TP3', pnlPercent);
                    }
                    // SL: Hit if Price hits SL
                    else if (currentPrice >= trade.sl) {
                        onCloseTrade(trade.id, 'SL', pnlPercent);
                    }
                }
            }
        });
    }, [trades, marketData, onCloseTrade, onPartialClose]);

    const [filterStatus, setFilterStatus] = useState('ALL'); // ALL, OPEN, CLOSED
    const [filterType, setFilterType] = useState('ALL'); // ALL, LONG, SHORT
    const [sortOrder, setSortOrder] = useState('NEWEST'); // NEWEST, OLDEST, PNL_HIGH, PNL_LOW

    const filteredTrades = trades.filter(trade => {
        const isOpen = !trade.status || trade.status === 'OPEN';
        if (filterStatus === 'OPEN' && !isOpen) return false;
        if (filterStatus === 'CLOSED' && isOpen) return false;
        if (filterType !== 'ALL' && trade.type !== filterType) return false;
        return true;
    }).sort((a, b) => {
        if (sortOrder === 'NEWEST') return b.id - a.id;
        if (sortOrder === 'OLDEST') return a.id - b.id;

        const isOpenA = !a.status || a.status === 'OPEN';
        const isOpenB = !b.status || b.status === 'OPEN';

        const pnlA = isOpenA ? calculatePnL(a) : (a.pnl || 0);
        const pnlB = isOpenB ? calculatePnL(b) : (b.pnl || 0);

        if (sortOrder === 'PNL_HIGH') return (pnlB || 0) - (pnlA || 0);
        if (sortOrder === 'PNL_LOW') return (pnlA || 0) - (pnlB || 0);
        return 0;
    });

    return (
        <div className="portfolio-container">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h2 style={{ margin: 0 }}>Portfolio Tracker</h2>
                {trades.length > 0 && (
                    <button
                        onClick={() => {
                            if (window.confirm('Are you sure you want to clear all trade history?')) {
                                localStorage.removeItem('abc_trades');
                                window.location.reload();
                            }
                        }}
                        style={{
                            background: 'transparent',
                            border: '1px solid var(--text-secondary)',
                            color: 'var(--text-secondary)',
                            padding: '5px 10px',
                            borderRadius: '5px',
                            cursor: 'pointer',
                            fontSize: '0.8rem'
                        }}
                    >
                        Clear History
                    </button>
                )}
            </div>

            <div className="stats-bar">
                <div className="stat">
                    <span>Balance</span>
                    <strong>${currentBalance.toFixed(2)}</strong>
                </div>
                <div className="stat">
                    <span>Net Profit</span>
                    <strong className={accountGrowthPercent >= 0 ? 'text-green' : 'text-red'}>
                        {accountGrowthPercent > 0 ? '+' : ''}{accountGrowthPercent.toFixed(2)}%
                        <span style={{ fontSize: '0.8em', opacity: 0.7, marginLeft: '5px' }}>
                            (${totalAccountPnL.toFixed(2)})
                        </span>
                    </strong>
                </div>
                <div className="stat">
                    <span>Open PnL</span>
                    <strong className={unrealizedPnL >= 0 ? 'text-green' : 'text-red'}>
                        ${unrealizedPnL.toFixed(2)}
                    </strong>
                </div>
            </div>

            <div className="filters-bar" style={{ display: 'flex', gap: '10px', marginBottom: '15px', flexWrap: 'wrap' }}>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                    <option value="ALL">All Status</option>
                    <option value="OPEN">Open Only</option>
                    <option value="CLOSED">Closed Only</option>
                </select>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                    <option value="ALL">All Types</option>
                    <option value="LONG">Long Only</option>
                    <option value="SHORT">Short Only</option>
                </select>
                <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                    <option value="NEWEST">Newest First</option>
                    <option value="OLDEST">Oldest First</option>
                    <option value="PNL_HIGH">Highest PnL</option>
                    <option value="PNL_LOW">Lowest PnL</option>
                </select>
            </div>

            <div className="trades-list">
                {filteredTrades.length === 0 ? (
                    <p className="no-trades">No trades match your filters.</p>
                ) : (
                    filteredTrades.map((trade) => {
                        const isOpen = !trade.status || trade.status === 'OPEN';
                        const pnl = isOpen ? calculatePnL(trade) : null;

                        return (
                            <div key={trade.id} className={`trade-item ${!isOpen ? trade.status.toLowerCase() : 'active'}`}>
                                <div className="trade-header">
                                    <span className="trade-symbol">{trade.symbol}</span>
                                    <span className={`trade-type ${trade.type.toLowerCase()}`}>{trade.type}</span>
                                </div>
                                <div className="trade-info">
                                    <span>Entry: ${trade.entry.toFixed(2)} <span style={{ fontSize: '0.85em', color: '#aaa', marginLeft: '5px' }}>({marketData[trade.symbol] ? `$${marketData[trade.symbol].toFixed(2)}` : 'Loading...'})</span></span>
                                    <span>Lev: {trade.leverage}x</span>
                                </div>

                                {isOpen && (
                                    <div className="trade-pnl">
                                        <span>PnL: </span>
                                        <strong className={pnl >= 0 ? 'text-green' : 'text-red'}>
                                            {pnl !== null ? `${pnl.toFixed(2)}%` : '...'}
                                        </strong>
                                    </div>
                                )}

                                <div className="trade-targets">
                                    {trade.tp1 && (
                                        <small className={`tp-tag ${trade.tp1Hit ? 'hit' : ''}`}>
                                            TP1: ${trade.tp1.toFixed(2)} {trade.tp1Hit && '✓'}
                                        </small>
                                    )}
                                    {trade.tp2 && (
                                        <small className={`tp-tag ${trade.tp2Hit ? 'hit' : ''}`}>
                                            TP2: ${trade.tp2.toFixed(2)} {trade.tp2Hit && '✓'}
                                        </small>
                                    )}
                                    <small className="tp-tag main-tp">{trade.tp1 ? 'TP3' : 'TP'}: ${trade.tp.toFixed(2)}</small>
                                    <small className="sl-tag">SL: ${trade.sl.toFixed(2)}</small>
                                </div>

                                {isOpen && (
                                    <div className="trade-actions">
                                        <button className="close-win" onClick={() => onCloseTrade(trade.id, 'WIN', pnl || 0)}>Close Win</button>
                                        <button className="close-loss" onClick={() => onCloseTrade(trade.id, 'LOSS', pnl || 0)}>Close Loss</button>
                                    </div>
                                )}
                                {!isOpen && (
                                    <div className="trade-status">
                                        Result: {trade.status}
                                        {trade.pnl != null && (
                                            <span style={{ marginLeft: '10px', color: trade.pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                                                {trade.pnl > 0 ? '+' : ''}{Number(trade.pnl).toFixed(2)}%
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default Portfolio;
