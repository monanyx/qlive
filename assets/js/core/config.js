/**
 * Static configuration: tradable symbols, venue identifiers and app defaults.
 *
 * Every symbol is quoted in USD. Binance only lists USDT pairs; for display
 * and paper trading we treat USDT ≈ USD and label the quote accordingly.
 */

export const SYMBOLS = {
  BTC: {
    id: 'BTC',
    name: 'Bitcoin',
    priceDecimals: 2,
    sizeDecimals: 5,
    groupings: [0.01, 0.1, 1, 5, 10, 50, 100],
    defaultGrouping: 1,
    // Simulator defaults (used only when no live price has ever been seen).
    sim: { price: 64250, vol: 0.55, topNotional: 45000 },
    venues: { coinbase: 'BTC-USD', binance: 'btcusdt', kraken: 'BTC/USD', krakenRest: 'XBTUSD' },
  },
  ETH: {
    id: 'ETH',
    name: 'Ethereum',
    priceDecimals: 2,
    sizeDecimals: 4,
    groupings: [0.01, 0.1, 0.5, 1, 5, 10],
    defaultGrouping: 0.1,
    sim: { price: 3150, vol: 0.7, topNotional: 30000 },
    venues: { coinbase: 'ETH-USD', binance: 'ethusdt', kraken: 'ETH/USD', krakenRest: 'ETHUSD' },
  },
  SOL: {
    id: 'SOL',
    name: 'Solana',
    priceDecimals: 2,
    sizeDecimals: 3,
    groupings: [0.01, 0.05, 0.1, 0.5, 1],
    defaultGrouping: 0.01,
    sim: { price: 148.5, vol: 0.9, topNotional: 15000 },
    venues: { coinbase: 'SOL-USD', binance: 'solusdt', kraken: 'SOL/USD', krakenRest: 'SOLUSD' },
  },
  XRP: {
    id: 'XRP',
    name: 'XRP',
    priceDecimals: 4,
    sizeDecimals: 1,
    groupings: [0.0001, 0.0005, 0.001, 0.005, 0.01],
    defaultGrouping: 0.0001,
    sim: { price: 0.5875, vol: 0.85, topNotional: 12000 },
    venues: { coinbase: 'XRP-USD', binance: 'xrpusdt', kraken: 'XRP/USD', krakenRest: 'XRPUSD' },
  },
  DOGE: {
    id: 'DOGE',
    name: 'Dogecoin',
    priceDecimals: 5,
    sizeDecimals: 0,
    groupings: [0.00001, 0.0001, 0.0005, 0.001],
    defaultGrouping: 0.00001,
    sim: { price: 0.12345, vol: 1.0, topNotional: 8000 },
    venues: { coinbase: 'DOGE-USD', binance: 'dogeusdt', kraken: 'DOGE/USD', krakenRest: 'XDGUSD' },
  },
};

export const SYMBOL_IDS = Object.keys(SYMBOLS);

export const EXCHANGES = {
  coinbase: { id: 'coinbase', name: 'Coinbase', long: 'Coinbase Exchange', quote: 'USD', live: true },
  binance: { id: 'binance', name: 'Binance', long: 'Binance Spot', quote: 'USDT', live: true },
  kraken: { id: 'kraken', name: 'Kraken', long: 'Kraken Spot (WS v2)', quote: 'USD', live: true },
  sim: { id: 'sim', name: 'Simulator', long: 'QuantumLive market simulator', quote: 'USD', live: false },
};

export const EXCHANGE_IDS = Object.keys(EXCHANGES);

/** Candle timeframes in seconds. */
export const TIMEFRAMES = [
  { sec: 1, label: '1s' },
  { sec: 60, label: '1m' },
  { sec: 300, label: '5m' },
  { sec: 900, label: '15m' },
  { sec: 3600, label: '1h' },
];

export const DEFAULTS = {
  symbol: 'BTC',
  exchange: 'coinbase',
  timeframe: 60,
  chartMode: 'candles',
  startingCash: 100_000,
  takerFee: 0.001, // 0.10 %
  makerFee: 0.0005, // 0.05 %
  largeTradeUsd: 50_000,
  autoFallback: true,
  simLatency: true,
  flashes: true,
  sounds: false,
};

/** How long a live feed may take to deliver market data before we fall back. */
export const LIVE_TIMEOUT_MS = 9000;

export const pairLabel = (symbol, exchange) => `${symbol}-${EXCHANGES[exchange]?.quote ?? 'USD'}`;

/**
 * Number of decimals needed to represent `step` exactly. Works on the value
 * rather than its string form because e.g. 10 ** -5 evaluates to
 * 0.000009999999999999999 in V8.
 */
export const decimalsOf = (step) => {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let d = 0; d <= 12; d++) {
    const x = step * 10 ** d;
    if (Math.abs(x - Math.round(x)) < 1e-9 * Math.max(1, x)) return d;
  }
  return 12;
};

/** Minimum price increment for a symbol (exactly representable). */
export const tickSize = (symbolId) => {
  const d = SYMBOLS[symbolId].priceDecimals;
  return Number((1 / 10 ** d).toFixed(d));
};
