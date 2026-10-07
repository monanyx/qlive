import { Emitter } from '../core/emitter.js';

/**
 * Price alerts. An alert fires once when the last trade price crosses its
 * level in the configured direction, then is removed.
 */
export class PriceAlerts extends Emitter {
  constructor({ storage = null, key = 'alerts.v1', now = () => Date.now() } = {}) {
    super();
    this.storage = storage;
    this.key = key;
    this.now = now;
    this.list = storage?.get(key, []) ?? [];
    this.seq = this.list.length + 1;
  }

  /** Create an alert; direction is inferred from the current price. */
  add(symbol, price, current) {
    if (!(price > 0)) return null;
    const alert = {
      id: `${this.now().toString(36)}-${this.seq++}`,
      symbol,
      price,
      direction: Number.isFinite(current) && price < current ? 'below' : 'above',
      createdAt: this.now(),
    };
    this.list.push(alert);
    this.#save();
    return alert;
  }

  remove(id) {
    const n = this.list.length;
    this.list = this.list.filter((a) => a.id !== id);
    if (this.list.length !== n) this.#save();
  }

  forSymbol(symbol) {
    return this.list.filter((a) => a.symbol === symbol);
  }

  /** Check a new last price; returns the alerts that fired. */
  check(symbol, price) {
    if (!Number.isFinite(price)) return [];
    const fired = this.list.filter(
      (a) => a.symbol === symbol && (a.direction === 'above' ? price >= a.price : price <= a.price),
    );
    if (!fired.length) return fired;
    const ids = new Set(fired.map((a) => a.id));
    this.list = this.list.filter((a) => !ids.has(a.id));
    this.#save();
    for (const a of fired) this.emit('fire', a, price);
    return fired;
  }

  #save() {
    this.storage?.set(this.key, this.list);
    this.emit('change');
  }
}
