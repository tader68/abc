import React from 'react';

const NewsFeed = ({ news }) => {
    const analyzeSentiment = (title) => {
        const bullishKeywords = ['soar', 'surge', 'jump', 'high', 'record', 'buy', 'bull', 'approve', 'gain', 'up'];
        const bearishKeywords = ['drop', 'crash', 'fall', 'low', 'ban', 'bear', 'sell', 'down', 'loss', 'hack'];

        const lowerTitle = title.toLowerCase();
        const isBullish = bullishKeywords.some(k => lowerTitle.includes(k));
        const isBearish = bearishKeywords.some(k => lowerTitle.includes(k));

        if (isBullish) return { label: 'BULLISH', color: 'text-green' };
        if (isBearish) return { label: 'BEARISH', color: 'text-red' };
        return { label: 'NEUTRAL', color: 'text-gray' };
    };

    return (
        <div className="news-feed-container">
            <h3>Crypto News & Sentiment</h3>
            <div className="news-list">
                {news.map(item => {
                    const sentiment = analyzeSentiment(item.title);
                    return (
                        <div key={item.id} className="news-item">
                            <div className="news-header">
                                <span className="news-source">{item.source}</span>
                                <span className={`news-sentiment ${sentiment.color}`}>{sentiment.label}</span>
                            </div>
                            <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-title">
                                {item.title}
                            </a>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default NewsFeed;
