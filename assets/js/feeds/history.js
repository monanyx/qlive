import { SYMBOLS } from '../core/config.js';

/**
 * Historical candles from public REST endpoints, normalised to
 * [{ time (s), open, high, low, close, volume }] ascending.
 *
 * All endpoints are unauthenticated. Failure (network, CORS, geo-blocking,
 * unsupported interval) resolves to [] — the chart then builds from live
 * trades only.
 */

async function getJson(url, { signal, timeoutMs = 7000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const COINBASE_GRANULARITIES = [60, 300, 900, 3600, 21600, 86400];
const BINANCE_INTERVALS = { 1: '1s', 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 86400: '1d' };
const KRAKEN_INTERVALS = { 60: 1, 300: 5, 900: 15, 3600: 60, 86400: 1440 };

export const historyUrl = (exchange, symbol, intervalSec, limit = 500) => {
  const v = SYMBOLS[symbol].venues;
  switch (exchange) {
    case 'coinbase':
      if (!COINBASE_GRANULARITIES.includes(intervalSec)) return null;
      return `https://api.exchange.coinbase.com/products/${v.coinbase}/candles?granularity=${intervalSec}`;
    case 'binance':
      if (!BINANCE_INTERVALS[intervalSec]) return null;
      return `https://api.binance.com/api/v3/klines?symbol=${v.binance.toUpperCase()}&interval=${BINANCE_INTERVALS[intervalSec]}&limit=${Math.min(1000, limit)}`;
    case 'kraken':
      if (!KRAKEN_INTERVALS[intervalSec]) return null;
      return `https://api.kraken.com/0/public/OHLC?pair=${v.krakenRest}&interval=${KRAKEN_INTERVALS[intervalSec]}`;
    default:
      return null;
  }
};

/** Parse a venue's candle payload (exported for tests). */
export function parseHistory(exchange, payload) {
  let bars = [];
  if (exchange === 'coinbase' && Array.isArray(payload)) {
    // [time, low, high, open, close, volume], newest first
    bars = payload.map(([t, l, h, o, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }));
  } else if (exchange === 'binance' && Array.isArray(payload)) {
    // [openTime(ms), open, high, low, close, volume, ...]
    bars = payload.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
    }));
  } else if (exchange === 'kraken' && payload?.result) {
    if (payload.error?.length) throw new Error(payload.error.join(', '));
    const key = Object.keys(payload.result).find((k) => k !== 'last');
    // [time, open, high, low, close, vwap, volume, count]
    bars = (payload.result[key] ?? []).map((k) => ({
      time: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[6],
    }));
  }
  return bars.filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close)).sort((a, b) => a.time - b.time);
}

export async function fetchHistory(exchange, symbol, intervalSec, { signal, limit = 500 } = {}) {
  const url = historyUrl(exchange, symbol, intervalSec, limit);
  if (!url) return [];
  try {
    return parseHistory(exchange, await getJson(url, { signal })).slice(-limit);
  } catch (err) {
    if (err.name !== 'AbortError')
      console.info(`[history] ${exchange} ${symbol} ${intervalSec}s unavailable:`, err.message);
    return [];
  }
}
