import { roundTo } from '../core/format.js';

/**
 * One side of a price-level (L2) order book.
 *
 * Prices are kept in an array sorted best → worst (bids descending, asks
 * ascending) next to a Map of price → size. Inserts/deletes use binary search
 * + splice, which stays fast even for full-depth books with tens of thousands
 * of levels, and reads of the top N levels are O(N) with no sorting.
 */
export class BookSide {
  constructor(isBid) {
    this.isBid = isBid;
    this.prices = [];
    this.sizes = new Map();
  }

  get length() {
    return this.prices.length;
  }

  /** Index of the first level that is not strictly better than `price`. */
  #lowerBound(price) {
    const { prices, isBid } = this;
    let lo = 0;
    let hi = prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = prices[mid];
      if (isBid ? p > price : p < price) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get(price) {
    return this.sizes.get(price) ?? 0;
  }

  set(price, size) {
    if (!(size > 0)) return this.delete(price);
    if (!this.sizes.has(price)) this.prices.splice(this.#lowerBound(price), 0, price);
    this.sizes.set(price, size);
    return true;
  }

  delete(price) {
    if (!this.sizes.delete(price)) return false;
    const i = this.#lowerBound(price);
    if (this.prices[i] === price) this.prices.splice(i, 1);
    return true;
  }

  /** Replace the whole side from [[price, size], ...] (any order). */
  load(levels) {
    this.sizes.clear();
    for (const [p, s] of levels) if (s > 0) this.sizes.set(p, s);
    this.prices = [...this.sizes.keys()].sort(this.isBid ? (a, b) => b - a : (a, b) => a - b);
  }

  clear() {
    this.prices = [];
    this.sizes.clear();
  }

  /** Drop everything beyond the best `n` levels. */
  truncate(n) {
    if (this.prices.length <= n) return;
    for (let i = n; i < this.prices.length; i++) this.sizes.delete(this.prices[i]);
    this.prices.length = n;
  }

  best() {
    return this.prices.length ? this.prices[0] : NaN;
  }

  worst() {
    return this.prices.length ? this.prices[this.prices.length - 1] : NaN;
  }

  /** Top `n` levels as [[price, size], ...] best first. */
  levels(n = Infinity) {
    const out = [];
    const m = Math.min(n, this.prices.length);
    for (let i = 0; i < m; i++) {
      const p = this.prices[i];
      out.push([p, this.sizes.get(p)]);
    }
    return out;
  }

  /**
   * Group levels into price buckets of width `step` (bids floor, asks ceil,
   * so a bucket never straddles the spread). Returns up to `n` buckets.
   */
  aggregate(n, step) {
    const out = [];
    const mode = this.isBid ? 'floor' : 'ceil';
    let bucket = NaN;
    let size = 0;
    for (const p of this.prices) {
      const b = roundTo(p, step, mode);
      if (b !== bucket) {
        if (size > 0) {
          out.push([bucket, size]);
          if (out.length >= n) return out;
        }
        bucket = b;
        size = 0;
      }
      size += this.sizes.get(p);
    }
    if (size > 0 && out.length < n) out.push([bucket, size]);
    return out;
  }

  /** Sum of size within `limitPrice` (inclusive) from the touch. */
  volumeTo(limitPrice) {
    let v = 0;
    for (const p of this.prices) {
      if (this.isBid ? p < limitPrice : p > limitPrice) break;
      v += this.sizes.get(p);
    }
    return v;
  }
}

export class OrderBook {
  constructor() {
    this.bids = new BookSide(true);
    this.asks = new BookSide(false);
    /** Incremented on every mutation — cheap dirty check for renderers. */
    this.version = 0;
    this.updatedAt = 0;
  }

  side(name) {
    return name === 'bid' || name === 'bids' || name === 'buy' ? this.bids : this.asks;
  }

  snapshot(bids, asks, ts = Date.now()) {
    this.bids.load(bids);
    this.asks.load(asks);
    this.version++;
    this.updatedAt = ts;
  }

  /** Apply one level change. `size <= 0` removes the level. */
  update(side, price, size, ts = Date.now()) {
    this.side(side).set(price, size);
    this.version++;
    this.updatedAt = ts;
  }

  truncate(depth) {
    this.bids.truncate(depth);
    this.asks.truncate(depth);
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.version++;
  }

  get empty() {
    return this.bids.length === 0 && this.asks.length === 0;
  }

  get bestBid() {
    return this.bids.best();
  }

  get bestAsk() {
    return this.asks.best();
  }

  get mid() {
    const b = this.bids.best();
    const a = this.asks.best();
    if (Number.isFinite(b) && Number.isFinite(a)) return (a + b) / 2;
    return Number.isFinite(b) ? b : a;
  }

  get spread() {
    return this.asks.best() - this.bids.best();
  }

  get spreadBps() {
    const m = this.mid;
    return m > 0 ? (this.spread / m) * 1e4 : NaN;
  }

  get isCrossed() {
    return this.bids.length > 0 && this.asks.length > 0 && this.bids.best() >= this.asks.best();
  }

  /**
   * Order-flow imbalance of the top `n` levels in [-1, 1]:
   * +1 = all resting size on the bid, −1 = all on the ask.
   */
  imbalance(n = 10) {
    let b = 0;
    let a = 0;
    for (const [, s] of this.bids.levels(n)) b += s;
    for (const [, s] of this.asks.levels(n)) a += s;
    return b + a > 0 ? (b - a) / (b + a) : 0;
  }

  /**
   * Cumulative depth curve for each side within ±`pct` of mid:
   * { bids: [[price, cumSize]...], asks: [...] } ordered from the touch out.
   */
  depthCurve(pct = 0.01, maxPoints = 4000) {
    const mid = this.mid;
    const curve = (side, inRange) => {
      const out = [];
      let cum = 0;
      for (const p of side.prices) {
        if (!inRange(p) || out.length >= maxPoints) break;
        cum += side.sizes.get(p);
        out.push([p, cum]);
      }
      return out;
    };
    return {
      mid,
      bids: curve(this.bids, (p) => p >= mid * (1 - pct)),
      asks: curve(this.asks, (p) => p <= mid * (1 + pct)),
    };
  }
}
