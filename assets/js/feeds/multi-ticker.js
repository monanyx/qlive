import { Emitter } from '../core/emitter.js';
import { SYMBOLS, SYMBOL_IDS, tickSize } from '../core/config.js';
import { createRng } from '../core/rng.js';
import { generateBars } from '../sim/market-sim.js';
import { normalizeCoinbase } from './normalize.js';
import { storage } from '../core/storage.js';

/**
 * Lightweight multi-symbol ticker for overview pages.
 *
 * Tries the Coinbase `ticker` channel for every symbol over one socket; if
 * nothing arrives within `timeoutMs` it switches to simulated tickers
 * (GBM random walks seeded from the last live price seen, if any).
 *
 * Emits 'tick' { symbol, last, open24h, high24h, low24h, volume24h, ts }
 * and 'source' ('live' | 'sim').
 */
export class MultiTicker extends Emitter {
  constructor({ symbols = SYMBOL_IDS, mode = 'auto', timeoutMs = 6000 } = {}) {
    super();
    this.symbols = symbols;
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.source = null;
    this.data = {};
  }

  start() {
    if (this.mode === 'sim') this.#startSim();
    else this.#startLive();
  }

  stop() {
    clearTimeout(this.timeout);
    clearInterval(this.simTimer);
    if (this.ws) {
      this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  #setSource(s) {
    this.source = s;
    this.emit('source', s);
  }

  #startLive() {
    const byProduct = Object.fromEntries(this.symbols.map((id) => [SYMBOLS[id].venues.coinbase, id]));
    try {
      this.ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    } catch {
      this.#startSim();
      return;
    }
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({ type: 'subscribe', product_ids: Object.keys(byProduct), channels: ['ticker'] }));
    this.ws.onmessage = (e) => {
      let events;
      try {
        events = normalizeCoinbase(JSON.parse(e.data));
      } catch {
        return;
      }
      for (const ev of events) {
        const symbol = byProduct[ev.product];
        if (ev.type !== 'ticker' || !symbol) continue;
        if (this.source !== 'live') {
          clearTimeout(this.timeout);
          this.#setSource('live');
        }
        storage.set(`lastPrice.${symbol}`, ev.last);
        this.#publish(symbol, ev);
      }
    };
    const fail = () => {
      if (this.source !== 'live') this.#startSim();
    };
    this.ws.onerror = fail;
    this.ws.onclose = fail;
    this.timeout = setTimeout(fail, this.timeoutMs);
  }

  #startSim() {
    if (this.source === 'sim') return;
    this.stop();
    this.#setSource('sim');
    const rng = createRng(Date.now());
    const nowSec = Math.floor(Date.now() / 1000);
    this.sims = this.symbols.map((id) => {
      const cfg = SYMBOLS[id];
      const price = storage.get(`lastPrice.${id}`) || cfg.sim.price;
      const sigma = cfg.sim.vol / Math.sqrt(365 * 86400);
      const bars = generateBars({
        endPrice: price,
        endTime: nowSec - (nowSec % 300),
        interval: 300,
        count: 288,
        sigmaPerSqrtSec: sigma,
        volumePerSec: (cfg.sim.topNotional * 0.15) / price,
        tick: tickSize(id),
        rng,
      });
      const open24h = bars[0].open;
      return {
        id,
        price,
        sigma,
        tick: tickSize(id),
        open24h,
        high: Math.max(...bars.map((b) => b.high)),
        low: Math.min(...bars.map((b) => b.low)),
        volume: bars.reduce((a, b) => a + b.volume, 0),
        bars,
      };
    });
    const step = () => {
      for (const s of this.sims) {
        s.price *= Math.exp(s.sigma * Math.sqrt(1.2) * rng.normal() * 3);
        const p = Math.round(s.price / s.tick) * s.tick;
        s.high = Math.max(s.high, p);
        s.low = Math.min(s.low, p);
        s.volume += (s.volume / 86400) * 1.2 * rng.lognormal(0, 0.5);
        this.#publish(s.id, {
          last: p,
          open24h: s.open24h,
          high24h: s.high,
          low24h: s.low,
          volume24h: s.volume,
          ts: Date.now(),
        });
      }
    };
    step();
    this.simTimer = setInterval(step, 1200);
  }

  /** 24 h of 5-minute closes for sparklines when simulated (else null). */
  simSeries(symbol) {
    return this.sims?.find((s) => s.id === symbol)?.bars.map((b) => b.close) ?? null;
  }

  #publish(symbol, ev) {
    const prev = this.data[symbol];
    const t = { symbol, ...ev, prev: prev?.last };
    this.data[symbol] = t;
    this.emit('tick', t);
  }
}
