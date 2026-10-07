import { decimalsOf } from '../core/config.js';
import { fmtBps, fmtPrice, fmtSize, fmtUsd, roundTo } from '../core/format.js';
import { QUOTE, walkBook } from '../trading/paper-engine.js';
import { $, $$, choiceGroup, setText } from './dom.js';

/**
 * Paper-trading order ticket. Shows live execution estimates (VWAP,
 * slippage, fees) computed by walking the current order book.
 */
export class OrderForm {
  constructor({ root, engine, market, config, onSubmitted = () => {}, onError = () => {} }) {
    this.root = root;
    this.engine = engine;
    this.market = market;
    this.config = config;
    this.onSubmitted = onSubmitted;
    this.onError = onError;
    this.side = 'buy';
    this.type = 'limit';

    this.el = {
      price: $('#f-price', root),
      stop: $('#f-stop', root),
      amount: $('#f-amount', root),
      total: $('#f-total', root),
      post: $('#f-post', root),
      ioc: $('#f-ioc', root),
      avail: $('#f-avail', root),
      submit: $('#f-submit', root),
      error: $('#f-error', root),
      estPrice: $('#e-price', root),
      estSlip: $('#e-slip', root),
      estFee: $('#e-fee', root),
      estTotal: $('#e-total', root),
      baseUnits: $$('[data-unit="base"]', root),
      quoteUnits: $$('[data-unit="quote"]', root),
    };

    this.sideGroup = choiceGroup($('.side-toggle', root), {
      attr: 'aria-checked',
      onChange: (s) => this.setSide(s, false),
    });
    this.typeGroup = choiceGroup($('#f-type', root), { attr: 'aria-checked', onChange: (t) => this.setType(t, false) });

    root.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.el.amount.addEventListener('input', () => this.#syncTotal());
    this.el.price.addEventListener('input', () => this.#syncTotal());
    this.el.stop.addEventListener('input', () => this.#syncTotal());
    this.el.total.addEventListener('input', () => this.#syncAmount());
    root.addEventListener('click', (e) => {
      const q = e.target.closest('[data-fill]');
      if (q) this.#quickPrice(q.dataset.fill);
      const pct = e.target.closest('[data-pct]');
      if (pct) this.setPct(Number(pct.dataset.pct));
    });
    this.setType('limit', false);
  }

  // ------------------------------------------------------------ public API

  setSide(side, sync = true) {
    this.side = side;
    if (sync) this.sideGroup.set(side, false);
    this.#labels();
    this.render();
  }

  setType(type, sync = true) {
    this.type = type;
    if (sync) this.typeGroup.set(type, false);
    for (const el of $$('[data-show]', this.root)) el.hidden = !el.dataset.show.split(' ').includes(type);
    if (type === 'limit' && !this.el.price.value) this.#quickPrice('mid');
    this.#labels();
    this.render();
  }

  setPrice(p) {
    const { tick } = this.config();
    const v = roundTo(p, tick);
    if (this.type === 'stop') this.el.stop.value = v;
    else {
      if (this.type === 'market') this.setType('limit');
      this.el.price.value = v;
    }
    this.#syncTotal();
  }

  setAmount(q) {
    const { sizeDecimals } = this.config();
    this.el.amount.value = q > 0 ? roundTo(q, 10 ** -sizeDecimals, 'floor') : '';
    this.#syncTotal();
  }

  focusAmount() {
    this.el.amount.focus();
    this.el.amount.select();
  }

  /** Called on symbol change. */
  reset() {
    this.primed = false;
    this.el.price.value = '';
    this.el.stop.value = '';
    this.el.amount.value = '';
    this.el.total.value = '';
    this.#error('');
    this.#labels();
    if (this.type === 'limit') this.#quickPrice('mid');
    this.render();
  }

  setPct(pct) {
    const ref = this.#refPrice();
    const { symbol } = this.config();
    if (this.side === 'buy') {
      if (!(ref > 0)) return;
      const cash = this.engine.available(QUOTE);
      this.setAmount(((cash / (ref * (1 + this.engine.fees.taker))) * pct) / 100);
    } else {
      this.setAmount((this.engine.available(symbol) * pct) / 100);
    }
  }

  snapshot() {
    const { book } = this.market;
    return { bids: book.bids.levels(800), asks: book.asks.levels(800), last: this.market.last };
  }

  submit() {
    const { symbol } = this.config();
    const req = {
      symbol,
      side: this.side,
      type: this.type,
      qty: Number(this.el.amount.value),
      price: Number(this.el.price.value),
      stopPrice: Number(this.el.stop.value),
      postOnly: this.el.post.checked,
      ioc: this.el.ioc.checked,
    };
    const r = this.engine.placeOrder(req, this.snapshot());
    if (!r.ok) {
      this.#error(r.error);
      this.onError(r.error);
      return r;
    }
    this.#error('');
    this.el.amount.value = '';
    this.el.total.value = '';
    this.onSubmitted(r.order);
    this.render();
    return r;
  }

  // ------------------------------------------------------------- internals

  #error(msg) {
    setText(this.el.error, msg);
    this.el.amount.setAttribute('aria-invalid', String(!!msg && /amount|balance|Minimum/.test(msg)));
  }

  #labels() {
    const { symbol, quote } = this.config();
    for (const u of this.el.baseUnits) setText(u, symbol);
    for (const u of this.el.quoteUnits) setText(u, quote);
    setText(this.el.submit, `${this.side === 'buy' ? 'Buy' : 'Sell'} ${symbol}${this.type === 'stop' ? ' stop' : ''}`);
    this.el.submit.className = `btn btn--lg btn--block ${this.side === 'buy' ? 'btn--buy' : 'btn--sell'}`;
  }

  #quickPrice(which) {
    const { book } = this.market;
    const { tick } = this.config();
    const p =
      which === 'bid' ? book.bestBid : which === 'ask' ? book.bestAsk : which === 'last' ? this.market.last : book.mid;
    if (!Number.isFinite(p)) return;
    const target = this.type === 'stop' ? this.el.stop : this.el.price;
    target.value = roundTo(p, tick);
    this.#syncTotal();
  }

  #refPrice() {
    const { book } = this.market;
    if (this.type === 'limit') return Number(this.el.price.value) || book.mid;
    if (this.type === 'stop') return Number(this.el.stop.value) || this.market.last;
    return this.side === 'buy' ? book.bestAsk : book.bestBid;
  }

  #syncTotal() {
    const q = Number(this.el.amount.value);
    const p = this.#refPrice();
    this.el.total.value = q > 0 && p > 0 ? (q * p).toFixed(2) : '';
    this.render();
  }

  #syncAmount() {
    const t = Number(this.el.total.value);
    const p = this.#refPrice();
    const { sizeDecimals } = this.config();
    this.el.amount.value = t > 0 && p > 0 ? roundTo(t / p, 10 ** -sizeDecimals, 'floor') : '';
    this.render();
  }

  /** Refresh available balance and execution estimate. */
  render() {
    const { symbol, tick, sizeDecimals } = this.config();
    // Pre-fill the limit price with the mid once the first book arrives.
    if (!this.primed && Number.isFinite(this.market.book.mid)) {
      this.primed = true;
      if (this.type === 'limit' && !this.el.price.value && document.activeElement !== this.el.price)
        this.#quickPrice('mid');
    }
    const dec = decimalsOf(tick);
    const avail =
      this.side === 'buy'
        ? fmtUsd(this.engine.available(QUOTE))
        : `${fmtSize(this.engine.available(symbol), sizeDecimals)} ${symbol}`;
    setText(this.el.avail, avail);

    const qty = Number(this.el.amount.value);
    const book = this.market.book;
    const isBuy = this.side === 'buy';
    let est = NaN;
    let slip = NaN;
    let liquidity = 'taker';

    if (qty > 0) {
      if (this.type === 'market') {
        const w = walkBook(isBuy ? book.asks.levels(800) : book.bids.levels(800), qty, isBuy);
        est = w.remaining > 1e-10 ? NaN : w.avg;
        const mid = book.mid;
        slip = Number.isFinite(est) && mid > 0 ? (Math.abs(est - mid) / mid) * 1e4 : NaN;
      } else if (this.type === 'limit') {
        est = Number(this.el.price.value);
        const marketable = isBuy ? book.bestAsk <= est : book.bestBid >= est;
        liquidity = marketable ? 'taker' : 'maker';
        if (marketable) {
          const w = walkBook(isBuy ? book.asks.levels(800) : book.bids.levels(800), qty, isBuy, est);
          if (w.filled > 0) est = (w.notional + w.remaining * est) / qty;
        }
      } else {
        est = Number(this.el.stop.value);
      }
    }
    const rate = liquidity === 'maker' ? this.engine.fees.maker : this.engine.fees.taker;
    const notional = qty * est;
    const fee = notional * rate;
    setText(
      this.el.estPrice,
      Number.isFinite(est) && qty > 0
        ? fmtPrice(est, dec)
        : this.type === 'market' && qty > 0
          ? 'Insufficient depth'
          : '—',
    );
    setText(
      this.el.estSlip,
      this.type === 'market' ? fmtBps(slip, 2) : liquidity === 'maker' ? 'Maker (rests)' : 'Crosses spread',
    );
    setText(this.el.estFee, Number.isFinite(fee) && qty > 0 ? `${fmtUsd(fee)} (${(rate * 100).toFixed(2)}%)` : '—');
    setText(
      this.el.estTotal,
      Number.isFinite(notional) && qty > 0 ? fmtUsd(isBuy ? notional + fee : notional - fee) : '—',
    );
  }
}
