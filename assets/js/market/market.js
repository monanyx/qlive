import { Emitter } from '../core/emitter.js';
import { OrderBook } from './orderbook.js';

/**
 * Market state for the active symbol, built from normalised feed events:
 *
 *   { type: 'book', action: 'snapshot', bids, asks, ts, recv, depth? }
 *   { type: 'book', action: 'delta', changes: [[side, price, size]], ts, recv, depth? }
 *   { type: 'trade', price, size, side, ts, recv, id? }      side = taker side
 *   { type: 'ticker', last?, open24h?, high24h?, low24h?, volume24h?, changePct?, ts, recv }
 *   { type: 'liquidation', side: 'long'|'short', price, size, ts }
 *
 * Events may carry `replay` (historical prints a venue sends on subscribe)
 * or `warmup` (simulator pre-run): both are shown but not traded on.
 *
 * Emits 'book', 'trade', 'ticker', 'liquidation' and 'integrity' (crossed
 * book that did not self-heal → the feed should resubscribe).
 */
export class Market extends Emitter {
  constructor({ symbol, latency = null, tradeCapacity = 1000 } = {}) {
    super();
    this.latency = latency;
    this.tradeCapacity = tradeCapacity;
    this.reset(symbol);
  }

  reset(symbol = this.symbol) {
    this.symbol = symbol;
    this.book = new OrderBook();
    this.trades = [];
    this.liquidations = [];
    this.ticker = {};
    this.lastPrice = NaN;
    this.prevPrice = NaN;
    this.lastTrade = null;
    this.crossedSince = 0;
    this.tradeVersion = 0;
    this.tickerVersion = 0;
    this.emit('reset', symbol);
  }

  get last() {
    return Number.isFinite(this.lastPrice) ? this.lastPrice : (this.ticker.last ?? NaN);
  }

  /** 24h change in percent, from whichever fields the venue provides. */
  get change24h() {
    const t = this.ticker;
    const last = this.last;
    if (Number.isFinite(t.open24h) && t.open24h > 0 && Number.isFinite(last))
      return ((last - t.open24h) / t.open24h) * 100;
    return t.changePct ?? NaN;
  }

  ingest(ev) {
    const t0 = performance.now();
    switch (ev.type) {
      case 'book':
        this.#book(ev);
        break;
      case 'trade':
        this.#trade(ev);
        break;
      case 'ticker':
        this.#ticker(ev);
        break;
      case 'liquidation':
        this.liquidations.push(ev);
        if (this.liquidations.length > 200) this.liquidations.shift();
        this.emit('liquidation', ev);
        break;
      default:
        return;
    }
    if (this.latency) {
      this.latency.record('apply', performance.now() - t0);
      this.latency.events.add(1);
      if (ev.recv && ev.ts && ev.type !== 'ticker' && !ev.replay && !ev.warmup)
        this.latency.record('feed', ev.recv - ev.ts);
    }
  }

  #book(ev) {
    const { book } = this;
    if (ev.action === 'snapshot') {
      book.snapshot(ev.bids, ev.asks, ev.ts);
    } else {
      for (const [side, price, size] of ev.changes) book.side(side).set(price, size);
      book.version++;
      book.updatedAt = ev.ts ?? Date.now();
    }
    if (ev.depth) book.truncate(ev.depth);

    if (book.isCrossed) {
      const now = Date.now();
      if (!this.crossedSince) this.crossedSince = now;
      else if (now - this.crossedSince > 3000) {
        this.crossedSince = 0;
        this.emit('integrity', 'Order book crossed for more than 3 s');
      }
    } else this.crossedSince = 0;

    this.emit('book', book);
  }

  #trade(ev) {
    this.prevPrice = this.lastPrice;
    this.lastPrice = ev.price;
    this.lastTrade = ev;
    this.trades.push(ev);
    if (this.trades.length > this.tradeCapacity) this.trades.splice(0, this.trades.length - this.tradeCapacity);
    this.tradeVersion++;
    this.emit('trade', ev);
  }

  #ticker(ev) {
    const t = this.ticker;
    for (const k of ['last', 'open24h', 'high24h', 'low24h', 'volume24h', 'changePct']) {
      if (Number.isFinite(ev[k])) t[k] = ev[k];
    }
    // Keep 24h extremes consistent with prints seen since the last ticker.
    if (Number.isFinite(this.lastPrice)) {
      if (Number.isFinite(t.high24h)) t.high24h = Math.max(t.high24h, this.lastPrice);
      if (Number.isFinite(t.low24h)) t.low24h = Math.min(t.low24h, this.lastPrice);
    }
    if (!Number.isFinite(this.lastPrice) && Number.isFinite(t.last)) this.lastPrice = t.last;
    this.tickerVersion++;
    this.emit('ticker', t);
  }

  /** Taker buy/sell volume (base units) over the last `windowMs`. */
  flow(windowMs = 60_000, now = Date.now()) {
    let buy = 0;
    let sell = 0;
    let count = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const tr = this.trades[i];
      if ((tr.recv ?? tr.ts) < now - windowMs) break;
      if (tr.side === 'buy') buy += tr.size;
      else sell += tr.size;
      count++;
    }
    return { buy, sell, count, ratio: buy + sell > 0 ? buy / (buy + sell) : 0.5 };
  }
}
