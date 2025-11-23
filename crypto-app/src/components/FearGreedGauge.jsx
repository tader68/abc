import React from 'react';

const FearGreedGauge = ({ value, label }) => {
    // Calculate rotation: 0 to 180 degrees
    // Value 0 = -90deg (Extreme Fear), 100 = 90deg (Extreme Greed)
    const rotation = (value / 100) * 180 - 90;

    let color = '#888';
    if (value < 25) color = '#ff2e2e'; // Extreme Fear (Red)
    else if (value < 45) color = '#ff9f43'; // Fear (Orange)
    else if (value < 55) color = '#feca57'; // Neutral (Yellow)
    else if (value < 75) color = '#1dd1a1'; // Greed (Light Green)
    else color = '#00b894'; // Extreme Greed (Green)

    return (
        <div className="gauge-container">
            <div className="gauge-body">
                <div className="gauge-fill" style={{ transform: `rotate(${rotation}deg)`, backgroundColor: color }}></div>
                <div className="gauge-cover">
                    <div className="gauge-value">{value}</div>
                    <div className="gauge-label">{label}</div>
                </div>
            </div>
            <div className="gauge-title">Market Sentiment</div>
        </div>
    );
};

export default FearGreedGauge;
