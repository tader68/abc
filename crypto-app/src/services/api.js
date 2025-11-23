
export const fetchCryptoPrice = async (symbol = 'BTCUSDT') => {
  try {
    const response = await fetch(`/api/v3/ticker/price?symbol=${symbol}`);
    const data = await response.json();
    return parseFloat(data.price);
  } catch (error) {
    console.error("Error fetching price:", error);
    return null;
  }
};

export const fetchKlines = async (symbol = 'BTCUSDT', interval = '1h', limit = 100) => {
  try {
    const response = await fetch(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const data = await response.json();
    // Binance kline format: [Open time, Open, High, Low, Close, Volume, ...]
    return data.map(k => ({
      time: k[0] / 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (error) {
    console.error("Error fetching klines:", error);
    return [];
  }
};

export const SUPPORTED_COINS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin' },
  { symbol: 'ETHUSDT', name: 'Ethereum' },
  { symbol: 'BNBUSDT', name: 'Binance Coin' },
  { symbol: 'SOLUSDT', name: 'Solana' },
  { symbol: 'XRPUSDT', name: 'Ripple' },
  { symbol: 'ADAUSDT', name: 'Cardano' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin' },
  { symbol: 'AVAXUSDT', name: 'Avalanche' },
  { symbol: 'TRXUSDT', name: 'Tron' },
  { symbol: 'DOTUSDT', name: 'Polkadot' },
  { symbol: 'LINKUSDT', name: 'Chainlink' },
  { symbol: 'POLUSDT', name: 'Polygon' },
  { symbol: 'SHIBUSDT', name: 'Shiba Inu' },
  { symbol: 'LTCUSDT', name: 'Litecoin' },
  { symbol: 'BCHUSDT', name: 'Bitcoin Cash' },
  { symbol: 'NEARUSDT', name: 'NEAR Protocol' },
  { symbol: 'UNIUSDT', name: 'Uniswap' },
  { symbol: 'ICPUSDT', name: 'Internet Computer' },
  { symbol: 'APTUSDT', name: 'Aptos' },
  { symbol: 'SUIUSDT', name: 'Sui' },
  { symbol: 'HBARUSDT', name: 'Hedera' },
  { symbol: 'XLMUSDT', name: 'Stellar' },
  { symbol: 'ATOMUSDT', name: 'Cosmos' },
  { symbol: 'STXUSDT', name: 'Stacks' },
  { symbol: 'FILUSDT', name: 'Filecoin' },
  { symbol: 'IMXUSDT', name: 'Immutable' },
  { symbol: 'OPUSDT', name: 'Optimism' },
  { symbol: 'VETUSDT', name: 'VeChain' },
  { symbol: 'INJUSDT', name: 'Injective' },
  { symbol: 'RNDRUSDT', name: 'Render' },
  { symbol: 'GRTUSDT', name: 'The Graph' },
  { symbol: 'ARBUSDT', name: 'Arbitrum' },
  { symbol: 'TIAUSDT', name: 'Celestia' },
  { symbol: 'RUNEUSDT', name: 'THORChain' },
  { symbol: 'SEIUSDT', name: 'Sei' },
  { symbol: 'ALGOUSDT', name: 'Algorand' },
  { symbol: 'ORDIUSDT', name: 'ORDI' },
  { symbol: 'FLOWUSDT', name: 'Flow' },
  { symbol: 'AAVEUSDT', name: 'Aave' },
  { symbol: 'EGLDUSDT', name: 'MultiversX' },
  { symbol: 'QNTUSDT', name: 'Quant' },
  { symbol: 'MINAUSDT', name: 'Mina' },
  { symbol: 'SNXUSDT', name: 'Synthetix' },
  { symbol: 'SANDUSDT', name: 'The Sandbox' },
  { symbol: 'AXSUSDT', name: 'Axie Infinity' },
  { symbol: 'MANAUSDT', name: 'Decentraland' },
  { symbol: 'THETAUSDT', name: 'Theta Network' },
  { symbol: 'FETUSDT', name: 'Fetch.ai' },
  { symbol: 'FTMUSDT', name: 'Fantom' },
  { symbol: 'WIFUSDT', name: 'dogwifhat' },
  { symbol: 'PEPEUSDT', name: 'Pepe' },
  { symbol: 'BONKUSDT', name: 'Bonk' },
  { symbol: 'FLOKIUSDT', name: 'Floki' },
  { symbol: 'EOSUSDT', name: 'EOS' },
  { symbol: 'XTZUSDT', name: 'Tezos' },
  { symbol: 'NEOUSDT', name: 'Neo' },
  { symbol: 'KAVAUSDT', name: 'Kava' },
  { symbol: 'CHZUSDT', name: 'Chiliz' },
  { symbol: 'GALAUSDT', name: 'Gala' },
  { symbol: 'LDOUSDT', name: 'Lido DAO' },
  { symbol: 'CRVUSDT', name: 'Curve DAO' },
  { symbol: 'MKRUSDT', name: 'Maker' },
  { symbol: 'ZECUSDT', name: 'Zcash' },
  { symbol: 'IOTAUSDT', name: 'IOTA' },
  { symbol: 'DASHUSDT', name: 'Dash' },
  { symbol: 'ETCUSDT', name: 'Ethereum Classic' },
  { symbol: 'XMRUSDT', name: 'Monero' },
  { symbol: 'CAKEUSDT', name: 'PancakeSwap' },
  { symbol: 'ROSEUSDT', name: 'Oasis Network' },
  { symbol: 'KLAYUSDT', name: 'Klaytn' },
  { symbol: 'APEUSDT', name: 'ApeCoin' },
  { symbol: 'JUPUSDT', name: 'Jupiter' },
  { symbol: 'PYTHUSDT', name: 'Pyth Network' },
  { symbol: 'BLURUSDT', name: 'Blur' },
  { symbol: 'MEMEUSDT', name: 'Memecoin' },
  { symbol: 'DYDXUSDT', name: 'dYdX' },
  { symbol: '1INCHUSDT', name: '1inch Network' },
  { symbol: 'ENJUSDT', name: 'Enjin Coin' },
  { symbol: 'BATUSDT', name: 'Basic Attention Token' },
  { symbol: 'ZILUSDT', name: 'Zilliqa' },
  { symbol: 'GMTUSDT', name: 'STEPN' },
  { symbol: 'COMPUSDT', name: 'Compound' },
  { symbol: 'LUNAUSDT', name: 'Terra (LUNA 2.0)' },
  { symbol: 'LUNCUSDT', name: 'Terra Classic' },
  { symbol: 'USTCUSDT', name: 'TerraClassicUSD' },
  { symbol: 'TWTUSDT', name: 'Trust Wallet Token' },
  { symbol: 'FXSUSDT', name: 'Frax Share' },
  { symbol: 'RPLUSDT', name: 'Rocket Pool' },
  { symbol: 'WOOUSDT', name: 'WOO Network' },
  { symbol: 'AGIXUSDT', name: 'SingularityNET' },
  { symbol: 'OCEANUSDT', name: 'Ocean Protocol' },
  { symbol: 'JASMYUSDT', name: 'JasmyCoin' },
  { symbol: 'HOTUSDT', name: 'Holo' },
  { symbol: 'GLMUSDT', name: 'Golem' },
  { symbol: 'SSVUSDT', name: 'SSV Network' },
  { symbol: 'CFXUSDT', name: 'Conflux' },
  { symbol: 'MASKUSDT', name: 'Mask Network' },
  { symbol: 'ACHUSDT', name: 'Alchemy Pay' },
  { symbol: 'HIGHUSDT', name: 'Highstreet' },
  { symbol: 'DUSKUSDT', name: 'Dusk' },
  { symbol: 'ANKRUSDT', name: 'Ankr' },
  { symbol: 'COTIUSDT', name: 'COTI' },
  { symbol: 'DGBUSDT', name: 'DigiByte' },
  { symbol: 'ICXUSDT', name: 'ICON' },
  { symbol: 'QTUMUSDT', name: 'Qtum' },
  { symbol: 'YFIUSDT', name: 'yearn.finance' },
  { symbol: 'KSMUSDT', name: 'Kusama' },
  { symbol: 'RVNUSDT', name: 'Ravencoin' },
  { symbol: 'ONTUSDT', name: 'Ontology' },
  { symbol: 'ZRXUSDT', name: '0x' },
  { symbol: 'IOSTUSDT', name: 'IOST' },
  { symbol: 'WAXPUSDT', name: 'WAX' },
  { symbol: 'LSKUSDT', name: 'Lisk' },
  { symbol: 'OMGUSDT', name: 'OMG Network' },
  { symbol: 'BALUSDT', name: 'Balancer' },
  { symbol: 'SUSHIUSDT', name: 'SushiSwap' },
  { symbol: 'KDAUSDT', name: 'Kadena' },
  { symbol: 'CKBUSDT', name: 'Nervos Network' },
  { symbol: 'LPTUSDT', name: 'Livepeer' }
];

export const fetchCryptoNews = async () => {
  try {
    // Using CryptoCompare public API for news
    const response = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
    const data = await response.json();
    return data.Data.slice(0, 20).map(item => ({
      id: item.id,
      title: item.title,
      url: item.url,
      source: item.source,
      published_on: item.published_on
    }));
  } catch (error) {
    console.error("Error fetching news:", error);
    // Fallback mock news if API fails
    return [
      { id: 1, title: "Bitcoin Breaks $90k Barrier Amidst Institutional Buying", source: "CryptoDaily", url: "#", published_on: Date.now() / 1000 },
      { id: 2, title: "Ethereum Upgrade 'Pectra' Expected to Lower Fees", source: "CoinDesk", url: "#", published_on: Date.now() / 1000 },
      { id: 3, title: "SEC Approves New Crypto ETF Applications", source: "Bloomberg", url: "#", published_on: Date.now() / 1000 },
      { id: 4, title: "Market Sentiment Shifts to Extreme Greed", source: "Alternative.me", url: "#", published_on: Date.now() / 1000 },
      { id: 5, title: "Solana Network Sees Record Transaction Volume", source: "SolanaNews", url: "#", published_on: Date.now() / 1000 }
    ];
  }
};

export const fetchGlobalMetrics = async () => {
  try {
    // Fetch Fear & Greed Index
    const fngResponse = await fetch('https://api.alternative.me/fng/');
    const fngData = await fngResponse.json();
    const fearGreed = fngData.data[0];

    return {
      fearGreedIndex: parseInt(fearGreed.value),
      fearGreedLabel: fearGreed.value_classification,
      btcDominance: 58.4 + (Math.random() * 0.5 - 0.25) // Mocked real-time fluctuation around 58.4%
    };
  } catch (error) {
    console.error("Error fetching global metrics:", error);
    return {
      fearGreedIndex: 75,
      fearGreedLabel: "Greed",
      btcDominance: 58.4
    };
  }
};
