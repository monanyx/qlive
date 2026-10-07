import { Emitter } from '../core/emitter.js';

/**
 * Paper-trading engine: simulated spot account that executes against the
 * live (or simulated) order book without sending anything to an exchange.
 *
 * Execution model
 *  • Market orders walk the visible opposite side of the book level by level
 *    (VWAP fill, real slippage). Rejected if visible depth is insufficient.
 *  • Limit orders that cross the spread take liquidity up to their limit
 *    price; any remainder rests (unless IOC). Post-only orders that would
 *    cross are rejected.
 *  • Resting limits fill as maker at their limit price when the opposite
 *    touch reaches them (full fill) or a trade prints through them (partial
 *    fill, capped by the printed size). Queue position is not modelled, so
 *    prints *at* the limit price do not fill — a deliberately conservative rule.
 *  • Stop orders trigger when the last trade crosses the stop price and then
 *    execute as market orders.
 *
 * Accounting: one quote currency (USD), average-cost basis per asset
 * including fees, realised PnL on sells, funds reserved for open orders.
 */

export const QUOTE = 'USD';
const EPS = 1e-10;
/** Extra headroom reserved for buy stops, which fill at an unknown price. */
const STOP_BUFFER = 1.02;

/**
 * Walk book levels ([[price, size], ...] best first).
 * `limit` caps the worst acceptable price (null = no cap).
 */
export function walkBook(levels, qty, isBuy, limit = null) {
  const fills = [];
  let remaining = qty;
  let notional = 0;
  for (const [p, s] of levels) {
    if (remaining <= EPS) break;
    if (limit != null && (isBuy ? p > limit : p < limit)) break;
    const q = Math.min(s, remaining);
    fills.push([p, q]);
    notional += p * q;
    remaining -= q;
  }
  const filled = qty - Math.max(0, remaining);
  return {
    fills,
    filled,
    notional,
    avg: filled > EPS ? notional / filled : NaN,
    remaining: Math.max(0, remaining),
    worst: fills.length ? fills[fills.length - 1][0] : NaN,
  };
}

const freshState = (startingCash, now) => ({
  version: 1,
  startingCash,
  balances: { [QUOTE]: startingCash },
  cost: {}, // asset → total cost basis (USD, incl. fees)
  realized: {}, // asset → realised PnL (USD)
  feesPaid: 0,
  orders: [], // open orders
  history: [], // closed orders, newest first
  fills: [], // newest first
  marks: {}, // symbol → last mark price
  seq: 1,
  createdAt: now,
});

export class PaperEngine extends Emitter {
  constructor({
    storage = null,
    key = 'paper.v1',
    startingCash = 100_000,
    fees = { maker: 0.0005, taker: 0.001 },
    now = () => Date.now(),
    maxHistory = 300,
  } = {}) {
    super();
    this.storage = storage;
    this.key = key;
    this.fees = { ...fees };
    this.now = now;
    this.maxHistory = maxHistory;
    const saved = storage?.get(key);
    this.state = saved?.version === 1 ? saved : freshState(startingCash, now());
  }

  // --------------------------------------------------------------- queries

  balance(asset) {
    return this.state.balances[asset] ?? 0;
  }

  reserved(asset) {
    let r = 0;
    for (const o of this.state.orders) {
      const rem = o.qty - o.filled;
      if (asset === QUOTE && o.side === 'buy') {
        const px = o.type === 'stop' ? o.stopPrice * STOP_BUFFER : o.price;
        r += rem * px * (1 + this.fees.taker);
      } else if (asset === o.symbol && o.side === 'sell') r += rem;
    }
    return r;
  }

  available(asset) {
    return Math.max(0, this.balance(asset) - this.reserved(asset));
  }

  openOrders(symbol) {
    return symbol ? this.state.orders.filter((o) => o.symbol === symbol) : this.state.orders;
  }

  mark(symbol) {
    return this.state.marks[symbol];
  }

  setMark(symbol, price) {
    if (Number.isFinite(price) && price > 0) this.state.marks[symbol] = price;
  }

  positions() {
    const out = [];
    const assets = new Set([...Object.keys(this.state.balances), ...Object.keys(this.state.realized)]);
    for (const asset of assets) {
      if (asset === QUOTE) continue;
      const qty = this.balance(asset);
      const realized = this.state.realized[asset] ?? 0;
      if (qty <= EPS && Math.abs(realized) < 0.005) continue;
      const cost = this.state.cost[asset] ?? 0;
      const mark = this.state.marks[asset];
      const value = Number.isFinite(mark) ? qty * mark : NaN;
      out.push({
        asset,
        qty,
        available: this.available(asset),
        avgCost: qty > EPS ? cost / qty : NaN,
        cost,
        mark,
        value,
        unrealized: qty > EPS ? value - cost : 0,
        realized,
      });
    }
    return out.sort((a, b) => (b.value || 0) - (a.value || 0));
  }

  equity() {
    let eq = this.balance(QUOTE);
    for (const [asset, qty] of Object.entries(this.state.balances)) {
      if (asset === QUOTE || qty <= EPS) continue;
      const m = this.state.marks[asset];
      if (Number.isFinite(m)) eq += qty * m;
      else eq += this.state.cost[asset] ?? 0; // no mark yet — value at cost
    }
    return eq;
  }

  summary() {
    const equity = this.equity();
    const realized = Object.values(this.state.realized).reduce((a, b) => a + b, 0);
    return {
      equity,
      cash: this.balance(QUOTE),
      availableCash: this.available(QUOTE),
      pnl: equity - this.state.startingCash,
      pnlPct: ((equity - this.state.startingCash) / this.state.startingCash) * 100,
      realized,
      feesPaid: this.state.feesPaid,
      startingCash: this.state.startingCash,
    };
  }

  // -------------------------------------------------------------- commands

  /**
   * Place an order.
   * @param {object} req  { symbol, side, type: 'market'|'limit'|'stop', qty, price?, stopPrice?, postOnly?, ioc? }
   * @param {object} mkt  { bids, asks, last } — book levels best-first and last trade price
   * @returns {{ ok: boolean, order?: object, error?: string }}
   */
  placeOrder(req, mkt) {
    const { symbol, side, type } = req;
    const qty = Number(req.qty);
    const isBuy = side === 'buy';
    const bestBid = mkt.bids?.[0]?.[0];
    const bestAsk = mkt.asks?.[0]?.[0];

    const reject = (error) => {
      this.emit('reject', { ...req, error });
      return { ok: false, error };
    };

    if (!['buy', 'sell'].includes(side)) return reject('Invalid side');
    if (!['market', 'limit', 'stop'].includes(type)) return reject('Invalid order type');
    if (!(qty > 0) || !Number.isFinite(qty)) return reject('Enter an amount greater than zero');

    const order = {
      id: `${this.now().toString(36)}-${this.state.seq++}`,
      symbol,
      side,
      type,
      qty,
      price: type === 'limit' ? Number(req.price) : null,
      stopPrice: type === 'stop' ? Number(req.stopPrice) : null,
      postOnly: !!req.postOnly,
      ioc: !!req.ioc,
      filled: 0,
      avgPrice: NaN,
      fees: 0,
      status: 'open',
      createdAt: this.now(),
      updatedAt: this.now(),
    };

    if (type === 'limit' && !(order.price > 0)) return reject('Enter a limit price');
    if (type === 'stop') {
      if (!(order.stopPrice > 0)) return reject('Enter a stop price');
      const last = mkt.last;
      if (Number.isFinite(last)) {
        if (isBuy && order.stopPrice <= last) return reject('Buy stop must be above the last price');
        if (!isBuy && order.stopPrice >= last) return reject('Sell stop must be below the last price');
      }
    }

    const refPrice = order.price ?? order.stopPrice ?? (isBuy ? bestAsk : bestBid) ?? mkt.last;
    if (!(refPrice > 0)) return reject('No market price available yet');
    if (qty * refPrice < 1) return reject('Minimum order value is $1');

    // Funds check for the whole order up-front.
    if (isBuy) {
      const need =
        type === 'market'
          ? NaN // checked after walking the book
          : qty * (type === 'stop' ? order.stopPrice * STOP_BUFFER : order.price) * (1 + this.fees.taker);
      if (Number.isFinite(need) && need > this.available(QUOTE) + EPS) return reject(`Insufficient ${QUOTE} balance`);
    } else if (qty > this.available(symbol) + EPS) return reject(`Insufficient ${symbol} balance`);

    if (type === 'market') {
      const r = this.#executeMarket(order, mkt);
      if (!r.ok) return reject(r.error);
      return { ok: true, order };
    }

    if (type === 'limit') {
      const marketable = isBuy ? bestAsk <= order.price : bestBid >= order.price;
      if (marketable && order.postOnly) return reject('Post-only order would take liquidity');
      if (marketable) {
        const w = walkBook(isBuy ? mkt.asks : mkt.bids, qty, isBuy, order.price);
        for (const [p, q] of w.fills) this.#fill(order, p, q, 'taker');
      }
      if (order.qty - order.filled <= EPS) return this.#close(order, 'filled');
      if (order.ioc) return this.#close(order, order.filled > 0 ? 'filled' : 'canceled');
    }

    this.state.orders.push(order);
    this.emit('order', order, 'placed');
    this.#changed();
    return { ok: true, order };
  }

  cancel(id) {
    const i = this.state.orders.findIndex((o) => o.id === id);
    if (i < 0) return false;
    const [order] = this.state.orders.splice(i, 1);
    this.#close(order, 'canceled');
    return true;
  }

  cancelAll(symbol) {
    const ids = this.openOrders(symbol).map((o) => o.id);
    ids.forEach((id) => this.cancel(id));
    return ids.length;
  }

  reset(startingCash = this.state.startingCash) {
    const marks = this.state.marks;
    this.state = freshState(startingCash, this.now());
    this.state.marks = marks;
    this.emit('reset');
    this.#changed();
  }

  setFees(fees) {
    Object.assign(this.fees, fees);
  }

  /**
   * Feed market data for `symbol`. Matches resting limits and triggers stops.
   * @param {string} symbol
   * @param {object} mkt  { bids, asks, last, trade? } — `trade` is the print that caused this call
   */
  onMarket(symbol, mkt) {
    const mid = mkt.bids?.[0] && mkt.asks?.[0] ? (mkt.bids[0][0] + mkt.asks[0][0]) / 2 : mkt.last;
    this.setMark(symbol, mid);
    const orders = this.state.orders.filter((o) => o.symbol === symbol);
    if (!orders.length) return;

    const bestBid = mkt.bids?.[0]?.[0];
    const bestAsk = mkt.asks?.[0]?.[0];
    const trade = mkt.trade;

    for (const o of orders) {
      const isBuy = o.side === 'buy';
      const rem = o.qty - o.filled;
      if (o.type === 'limit') {
        if (isBuy ? bestAsk <= o.price : bestBid >= o.price) {
          this.#fill(o, o.price, rem, 'maker');
        } else if (trade && (isBuy ? trade.price < o.price : trade.price > o.price)) {
          this.#fill(o, o.price, Math.min(rem, trade.size), 'maker');
        }
        if (o.qty - o.filled <= EPS) this.#closeOpen(o, 'filled');
      } else if (o.type === 'stop' && Number.isFinite(mkt.last)) {
        if (isBuy ? mkt.last >= o.stopPrice : mkt.last <= o.stopPrice) {
          this.#removeOpen(o);
          this.emit('order', o, 'triggered');
          const r = this.#executeMarket(o, mkt);
          if (!r.ok) {
            o.reason = r.error;
            this.#close(o, 'rejected');
          }
        }
      }
    }
  }

  save() {
    this.storage?.set(this.key, this.state);
  }

  // -------------------------------------------------------------- internals

  #executeMarket(order, mkt) {
    const isBuy = order.side === 'buy';
    const rem = order.qty - order.filled;
    const w = walkBook(isBuy ? (mkt.asks ?? []) : (mkt.bids ?? []), rem, isBuy);
    if (w.remaining > EPS) return { ok: false, error: 'Not enough visible liquidity in the book' };
    if (isBuy) {
      const need = w.notional * (1 + this.fees.taker);
      // Funds reserved by this order (e.g. a triggered stop) are released first.
      if (need > this.available(QUOTE) + EPS) return { ok: false, error: `Insufficient ${QUOTE} balance` };
    } else if (rem > this.available(order.symbol) + EPS) {
      return { ok: false, error: `Insufficient ${order.symbol} balance` };
    }
    for (const [p, q] of w.fills) this.#fill(order, p, q, 'taker');
    this.#close(order, 'filled');
    return { ok: true };
  }

  #fill(order, price, qty, liquidity) {
    if (!(qty > EPS)) return;
    const s = this.state;
    const asset = order.symbol;
    const notional = price * qty;
    const fee = notional * (liquidity === 'maker' ? this.fees.maker : this.fees.taker);
    const b = s.balances;

    if (order.side === 'buy') {
      b[QUOTE] = (b[QUOTE] ?? 0) - notional - fee;
      b[asset] = (b[asset] ?? 0) + qty;
      s.cost[asset] = (s.cost[asset] ?? 0) + notional + fee;
    } else {
      const held = b[asset] ?? 0;
      const avg = held > EPS ? (s.cost[asset] ?? 0) / held : 0;
      b[QUOTE] = (b[QUOTE] ?? 0) + notional - fee;
      b[asset] = held - qty;
      s.cost[asset] = (s.cost[asset] ?? 0) - avg * qty;
      s.realized[asset] = (s.realized[asset] ?? 0) + notional - fee - avg * qty;
    }
    if (Math.abs(b[asset]) < EPS) {
      b[asset] = 0;
      s.cost[asset] = 0;
    }
    s.feesPaid += fee;

    const prev = order.filled;
    order.filled = prev + qty;
    order.avgPrice = prev > 0 ? (order.avgPrice * prev + notional) / order.filled : price;
    order.fees += fee;
    order.updatedAt = this.now();

    const fill = {
      id: `${order.id}.${s.fills.length + 1}`,
      orderId: order.id,
      symbol: asset,
      side: order.side,
      price,
      qty,
      fee,
      liquidity,
      ts: this.now(),
    };
    s.fills.unshift(fill);
    if (s.fills.length > this.maxHistory) s.fills.length = this.maxHistory;
    this.emit('fill', fill, order);
  }

  #removeOpen(order) {
    const i = this.state.orders.indexOf(order);
    if (i >= 0) this.state.orders.splice(i, 1);
  }

  #closeOpen(order, status) {
    this.#removeOpen(order);
    this.#close(order, status);
  }

  #close(order, status) {
    order.status = status;
    order.updatedAt = this.now();
    this.state.history.unshift(order);
    if (this.state.history.length > this.maxHistory) this.state.history.length = this.maxHistory;
    this.emit('order', order, status);
    this.#changed();
    return { ok: true, order };
  }

  #changed() {
    this.save();
    this.emit('change');
  }
}
