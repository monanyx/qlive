import { SYMBOLS } from '../core/config.js';
import { WsFeed } from './ws-feed.js';
import { normalizeBinance, normalizeCoinbase, normalizeKraken } from './normalize.js';

/** Coinbase Exchange public feed (no authentication required). */
export class CoinbaseFeed extends WsFeed {
  get product() {
    return SYMBOLS[this.symbol].venues.coinbase;
  }

  urls() {
    return ['wss://ws-feed.exchange.coinbase.com'];
  }

  subscriptions() {
    this.gotBook = false;
    return [
      {
        type: 'subscribe',
        product_ids: [this.product],
        // level2_batch = unauthenticated L2 snapshot + 50 ms batched updates.
        channels: ['level2_batch', 'matches', 'ticker', 'heartbeat'],
      },
    ];
  }

  normalize(msg, recv) {
    const events = normalizeCoinbase(msg, recv);
    if (events.some((e) => e.type === 'book')) this.gotBook = true;
    // Safety net: until a full L2 snapshot arrives (or if the L2 channel is
    // refused), show top of book from the ticker's best bid/ask.
    if (!this.gotBook && msg.type === 'ticker' && msg.best_bid && msg.best_ask) {
      events.push({
        type: 'book',
        action: 'snapshot',
        bids: [[+msg.best_bid, +msg.best_bid_size || 0]],
        asks: [[+msg.best_ask, +msg.best_ask_size || 0]],
        ts: recv,
        recv,
        topOfBook: true,
      });
    }
    return events;
  }
}

/** Binance spot combined stream. Falls back to the market-data-only host. */
export class BinanceFeed extends WsFeed {
  get stream() {
    return SYMBOLS[this.symbol].venues.binance;
  }

  urls() {
    const s = this.stream;
    const streams = `${s}@depth20@100ms/${s}@aggTrade/${s}@ticker`;
    return [
      `wss://stream.binance.com:9443/stream?streams=${streams}`,
      `wss://data-stream.binance.vision/stream?streams=${streams}`,
    ];
  }

  normalize(msg, recv) {
    return normalizeBinance(msg, recv);
  }
}

/** Kraken WebSocket API v2. */
export class KrakenFeed extends WsFeed {
  static DEPTH = 25;

  get pair() {
    return SYMBOLS[this.symbol].venues.kraken;
  }

  urls() {
    return ['wss://ws.kraken.com/v2'];
  }

  subscriptions() {
    const symbol = [this.pair];
    return [
      { method: 'subscribe', params: { channel: 'book', symbol, depth: KrakenFeed.DEPTH, snapshot: true } },
      { method: 'subscribe', params: { channel: 'trade', symbol, snapshot: true } },
      { method: 'subscribe', params: { channel: 'ticker', symbol } },
    ];
  }

  normalize(msg, recv) {
    return normalizeKraken(msg, recv, KrakenFeed.DEPTH);
  }
}

/**
 * Binance USDⓈ-M futures liquidation stream — the only major venue that
 * publishes forced orders publicly. Used regardless of the selected spot
 * venue (liquidations are a cross-market signal).
 */
export class BinanceLiquidationFeed extends WsFeed {
  constructor(opts) {
    super({ ...opts, staleMs: Infinity }); // liquidations can be minutes apart
  }

  urls() {
    return [`wss://fstream.binance.com/ws/${SYMBOLS[this.symbol].venues.binance}@forceOrder`];
  }

  isMarketData(ev) {
    return ev.type === 'liquidation';
  }

  normalize(msg, recv) {
    return normalizeBinance(msg, recv);
  }
}

export const LIVE_FEEDS = {
  coinbase: CoinbaseFeed,
  binance: BinanceFeed,
  kraken: KrakenFeed,
};
