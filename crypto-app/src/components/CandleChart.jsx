
import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

const CandleChart = ({ data, symbol }) => {
    const chartContainerRef = useRef();
    const chartRef = useRef();

    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: '#1e293b' },
                textColor: '#94a3b8',
            },
            grid: {
                vertLines: { color: '#334155' },
                horzLines: { color: '#334155' },
            },
            width: chartContainerRef.current.clientWidth,
            height: 350,
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 0,
                fixRightEdge: true,
                fixLeftEdge: true,
                tickMarkFormatter: (time, tickMarkType, locale) => {
                    const date = new Date(time * 1000);
                    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
                },
            },
        });

        const newSeries = chart.addSeries(CandlestickSeries, {
            upColor: '#10b981',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#ef4444',
        });

        newSeries.setData(data);
        chart.timeScale().fitContent();
        chartRef.current = chart;

        // ResizeObserver to handle container resizing
        const resizeObserver = new ResizeObserver(entries => {
            if (entries.length === 0 || !entries[0].contentRect) return;
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        });

        resizeObserver.observe(chartContainerRef.current);

        return () => {
            resizeObserver.disconnect();
            chart.remove();
        };
    }, [data]);

    return (
        <div className="chart-container" style={{ marginBottom: 0, height: '100%', minHeight: '350px', display: 'flex', flexDirection: 'column' }}>
            <div ref={chartContainerRef} style={{ flex: 1, width: '100%' }} />
        </div>
    );
};

export default CandleChart;
