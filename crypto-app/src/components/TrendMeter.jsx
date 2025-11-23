import React from 'react';

const TrendMeter = ({ adx, trend }) => {
    // ADX 0-20: Weak, 20-40: Moderate, 40-60: Strong, 60+: Extreme
    const width = Math.min(100, adx);

    let color = '#57606f'; // Weak
    let strengthText = 'Weak';

    if (adx >= 20) { color = '#feca57'; strengthText = 'Moderate'; }
    if (adx >= 40) { color = '#ff9f43'; strengthText = 'Strong'; }
    if (adx >= 60) { color = '#ff6b6b'; strengthText = 'Extreme'; }

    // If trend is UP, use Green accents, if DOWN use Red accents
    const trendColor = trend === 'UP' ? '#1dd1a1' : '#ff4757';

    return (
        <div className="trend-meter-container">
            <div className="meter-header">
                <span className="meter-title">Trend Strength (ADX)</span>
                <span className="meter-value" style={{ color: trendColor }}>
                    {trend} ({adx.toFixed(1)})
                </span>
            </div>
            <div className="meter-bar-bg">
                <div
                    className="meter-bar-fill"
                    style={{
                        width: `${width}%`,
                        backgroundColor: color,
                        boxShadow: `0 0 10px ${color}`
                    }}
                ></div>
            </div>
            <div className="meter-footer">
                <small>{strengthText}</small>
            </div>
        </div>
    );
};

export default TrendMeter;
