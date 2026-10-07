import { fmtCompact, fmtPrice, fmtSize, fmtTime, fmtUsd } from '../core/format.js';
import { h } from './dom.js';

/**
 * Time & sales tape. New prints are buffered and flushed once per frame,
 * newest on top, capped at `max` rows.
 *
 * Variants:
 *   'trades'       time · price · size
 *   'whales'       time · side · price · size · notional (large prints only)
 *   'liquidations' time · LONG/SHORT · price · size · notional
 */
export class TradeTape {
  constructor({ root, variant = 'trades', max = 80, config, isBig = () => false, emptyText = 'Waiting for trades…' }) {
    this.root = root;
    this.variant = variant;
    this.max = max;
    this.config = config;
    this.isBig = isBig;
    this.pending = [];
    this.wide = variant !== 'trades';
    this.root.classList.add('tape');
    this.root.classList.toggle('tape--wide', this.wide);
    const cols = this.wide
      ? ['Time', variant === 'liquidations' ? 'Pos.' : 'Side', 'Price', 'Size', 'Value']
      : ['Time', 'Price', 'Size'];
    this.head = h('div', { class: 'tape__cols', 'aria-hidden': 'true' }, ...cols.map((c) => h('span', {}, c)));
    this.list = h('div', { role: 'log', 'aria-live': 'off', 'aria-label': `${variant} list` });
    this.empty = h('div', { class: 'empty' }, emptyText);
    this.root.replaceChildren(this.head, this.list, this.empty);
  }

  push(item) {
    this.pending.push(item);
  }

  clear(emptyText) {
    this.pending = [];
    this.list.replaceChildren();
    if (emptyText) this.empty.textContent = emptyText;
    this.empty.hidden = false;
  }

  setEmptyText(text) {
    this.empty.textContent = text;
  }

  #row(t) {
    const { priceDecimals, sizeDecimals } = this.config();
    const side = this.variant === 'liquidations' ? (t.side === 'long' ? 'sell' : 'buy') : t.side;
    const cls = `tape-row ${side}${this.isBig(t) ? ' big' : ''}`;
    if (!this.wide) {
      return h(
        'div',
        { class: cls },
        h('span', { class: 't' }, fmtTime(t.ts ?? t.recv)),
        h('span', { class: 'p' }, fmtPrice(t.price, priceDecimals)),
        h('span', {}, fmtSize(t.size, sizeDecimals)),
      );
    }
    const label = this.variant === 'liquidations' ? t.side.toUpperCase() : t.side === 'buy' ? 'BUY' : 'SELL';
    const notional = t.price * t.size;
    return h(
      'div',
      { class: cls },
      h('span', { class: 't' }, fmtTime(t.ts ?? t.recv)),
      h('span', { class: 'p' }, label),
      h('span', { class: 'p' }, fmtPrice(t.price, priceDecimals)),
      h('span', {}, fmtSize(t.size, Math.min(sizeDecimals, 4))),
      h('span', {}, notional >= 1e6 ? `$${fmtCompact(notional)}` : fmtUsd(notional, 0)),
    );
  }

  render() {
    if (!this.pending.length) return;
    const items = this.pending.slice(-this.max);
    this.pending = [];
    const frag = document.createDocumentFragment();
    for (let i = items.length - 1; i >= 0; i--) frag.append(this.#row(items[i]));
    this.list.prepend(frag);
    while (this.list.childElementCount > this.max) this.list.lastElementChild.remove();
    this.empty.hidden = true;
  }
}
