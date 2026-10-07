import { decimalsOf } from '../core/config.js';
import { fmtBps, fmtCompact, fmtPrice, fmtSize, roundTo } from '../core/format.js';
import { $, h, setText } from './dom.js';

const ROW_H = 20;

/**
 * Order book ladder. Keeps a fixed pool of row elements per side and only
 * rewrites text/CSS variables, so repainting at 60 fps stays cheap.
 *
 * Depth bars show *cumulative* size from the touch, on a shared scale for
 * both sides so liquidity can be compared at a glance.
 */
export class OrderBookView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {import('../market/market.js').Market} o.market
   * @param {() => {tick:number, grouping:number, sizeDecimals:number}} o.config
   * @param {() => Array<{side:string, price:number}>} [o.openOrders]
   * @param {(price:number, side:'bid'|'ask', cumSize:number, e:MouseEvent) => void} [o.onPick]
   * @param {() => void} [o.onResize]
   */
  constructor({ root, market, config, openOrders = () => [], onPick = () => {}, onResize = () => {} }) {
    this.root = root;
    this.market = market;
    this.config = config;
    this.openOrders = openOrders;
    this.mode = 'both';
    this.asksEl = $('[data-book="asks"]', root);
    this.bidsEl = $('[data-book="bids"]', root);
    this.lastEl = $('[data-book="last"]', root);
    this.spreadEl = $('[data-book="spread"]', root);
    this.imbBar = $('[data-book="imb-bar"]', root);
    this.imbBid = $('[data-book="imb-bid"]', root);
    this.imbAsk = $('[data-book="imb-ask"]', root);
    this.rows = { ask: [], bid: [] };
    this.rowsPerSide = 12;

    root.addEventListener('click', (e) => {
      const row = e.target.closest('.book-row');
      if (!row || row.classList.contains('is-empty')) return;
      onPick(Number(row.dataset.price), row.dataset.side, Number(row.dataset.cum), e);
    });

    this.ro = new ResizeObserver(() => {
      const el = this.mode === 'bids' ? this.bidsEl : this.asksEl;
      const n = Math.min(60, Math.max(3, Math.floor(el.clientHeight / ROW_H)));
      if (n !== this.rowsPerSide) {
        this.rowsPerSide = n;
        onResize();
      }
    });
    this.ro.observe(this.asksEl);
    this.ro.observe(this.bidsEl);
  }

  setMode(mode) {
    this.mode = mode;
    this.asksEl.hidden = mode === 'bids';
    this.bidsEl.hidden = mode === 'asks';
  }

  #row(side, i) {
    const pool = this.rows[side];
    while (pool.length <= i) {
      const r = h(
        'div',
        { class: `book-row ${side}`, dataset: { side } },
        h('span', { class: 'px' }),
        h('span', { class: 'sz' }),
        h('span', { class: 'tot' }),
      );
      pool.push(r);
      (side === 'ask' ? this.asksEl : this.bidsEl).append(r);
    }
    return pool[i];
  }

  #fill(side, levels, maxCum, ctx) {
    const { priceDec, sizeDecimals, marks } = ctx;
    let cum = 0;
    const n = this.rowsPerSide;
    for (let i = 0; i < n; i++) {
      const row = this.#row(side, i);
      const lvl = levels[i];
      row.hidden = false;
      if (!lvl) {
        if (!row.classList.contains('is-empty')) {
          row.classList.add('is-empty');
          row.classList.remove('has-order');
          for (const c of row.children) c.textContent = '';
          row.style.setProperty('--depth', '0');
        }
        continue;
      }
      const [p, s] = lvl;
      cum += s;
      row.classList.remove('is-empty');
      row.dataset.price = p;
      row.dataset.cum = cum;
      const [px, sz, tot] = row.children;
      setText(px, fmtPrice(p, priceDec));
      setText(sz, fmtSize(s, sizeDecimals));
      setText(tot, cum >= 1e5 ? fmtCompact(cum) : fmtSize(cum, Math.min(sizeDecimals, 3)));
      row.style.setProperty('--depth', (cum / maxCum).toFixed(4));
      row.classList.toggle('has-order', marks.has(p));
    }
    // Hide rows beyond the current capacity (after a resize).
    for (let i = n; i < this.rows[side].length; i++) this.rows[side][i].hidden = true;
  }

  render() {
    const { book } = this.market;
    const { tick, grouping, sizeDecimals } = this.config();
    const step = Math.max(grouping, tick);
    const grouped = step > tick * 1.0000001;
    const n = this.rowsPerSide;
    const asks = grouped ? book.asks.aggregate(n, step) : book.asks.levels(n);
    const bids = grouped ? book.bids.aggregate(n, step) : book.bids.levels(n);

    const cumOf = (lv) => lv.reduce((a, [, s]) => a + s, 0);
    const maxCum = Math.max(this.mode !== 'bids' ? cumOf(asks) : 0, this.mode !== 'asks' ? cumOf(bids) : 0, 1e-12);
    const priceDec = decimalsOf(step);

    // Map the user's open limit orders onto (possibly grouped) price rows.
    const marks = { ask: new Set(), bid: new Set() };
    for (const o of this.openOrders()) {
      if (o.type !== 'limit') continue;
      const side = o.side === 'buy' ? 'bid' : 'ask';
      marks[side].add(grouped ? roundTo(o.price, step, side === 'bid' ? 'floor' : 'ceil') : o.price);
    }

    if (this.mode !== 'bids') this.#fill('ask', asks, maxCum, { priceDec, sizeDecimals, marks: marks.ask });
    if (this.mode !== 'asks') this.#fill('bid', bids, maxCum, { priceDec, sizeDecimals, marks: marks.bid });

    // Mid row: last trade with direction + spread.
    const last = this.market.last;
    const dir = last - this.market.prevPrice;
    setText(this.lastEl, Number.isFinite(last) ? `${fmtPrice(last, decimalsOf(tick))} ${dir < 0 ? '▼' : '▲'}` : '—');
    this.lastEl.classList.toggle('up', dir >= 0);
    this.lastEl.classList.toggle('down', dir < 0);
    const spread = book.spread;
    setText(
      this.spreadEl,
      Number.isFinite(spread)
        ? `Spread ${fmtPrice(spread, decimalsOf(tick))} · ${fmtBps(book.spreadBps, 2)}`
        : 'Spread —',
    );

    // Top-10 imbalance.
    const imb = book.imbalance(10);
    const bidPct = ((imb + 1) / 2) * 100;
    this.imbBar.style.width = `${bidPct.toFixed(1)}%`;
    setText(this.imbBid, `B ${bidPct.toFixed(0)}%`);
    setText(this.imbAsk, `${(100 - bidPct).toFixed(0)}% S`);
  }
}
