import { Emitter } from '../core/emitter.js';
import { EXCHANGES, LIVE_TIMEOUT_MS } from '../core/config.js';
import { LIVE_FEEDS } from './exchanges.js';
import { SimFeed } from './sim-feed.js';

/**
 * Owns the active market-data feed and its lifecycle.
 *
 * If a live venue cannot deliver market data within LIVE_TIMEOUT_MS
 * (blocked network, geo-restriction, outage) and auto-fallback is enabled,
 * the manager transparently switches to the simulator and reports it, so
 * the terminal is always usable. `retryLive()` goes back to the venue.
 *
 * Events: 'event' (normalised market event), 'status', 'fallback', 'notice'.
 */
export class FeedManager extends Emitter {
  constructor({
    latency = null,
    autoFallback = true,
    simDelay = true,
    simWarmup = 0,
    liveTimeoutMs = LIVE_TIMEOUT_MS,
    seedPrice = () => undefined,
  } = {}) {
    super();
    this.simWarmup = simWarmup;
    this.liveTimeoutMs = liveTimeoutMs;
    this.latency = latency;
    this.autoFallback = autoFallback;
    this.simDelay = simDelay;
    this.seedPrice = seedPrice;
    this.feed = null;
    this.exchange = null; // requested venue
    this.active = null; // venue actually streaming ('sim' when fallen back)
    this.symbol = null;
    this.status = { state: 'idle' };
    this.gen = 0;
  }

  get fallback() {
    return this.exchange !== 'sim' && this.active === 'sim';
  }

  start(exchange, symbol) {
    this.stop();
    this.exchange = exchange;
    this.symbol = symbol;
    this.#run(exchange);
  }

  retryLive() {
    if (this.exchange && this.exchange !== 'sim') this.start(this.exchange, this.symbol);
  }

  stop() {
    clearTimeout(this.fallbackTimer);
    this.gen++;
    if (this.feed) {
      const f = this.feed;
      this.feed = null;
      f.stop();
    }
  }

  resync(reason) {
    this.feed?.resync?.(reason);
  }

  /** Candle history from the simulator (null for live venues). */
  simHistory(intervalSec, count) {
    return this.active === 'sim' && this.feed?.history ? this.feed.history(intervalSec, count) : null;
  }

  #run(venue) {
    const gen = ++this.gen;
    this.active = venue;
    this.gotData = false;
    const guard = (fn) => (arg) => gen === this.gen && fn(arg);
    const opts = {
      symbol: this.symbol,
      latency: this.latency,
      onEvent: guard((ev) => {
        if (ev.type === 'error') {
          this.emit('notice', { level: 'warn', message: `${EXCHANGES[venue].name}: ${ev.message}` });
          return;
        }
        if (ev.type === 'book' || ev.type === 'trade') this.gotData = true;
        this.emit('event', ev);
      }),
      onStatus: guard((s) => {
        this.status = { ...s, exchange: venue, requested: this.exchange, fallback: this.fallback };
        this.emit('status', this.status);
      }),
    };

    if (venue === 'sim') {
      this.feed = new SimFeed({
        ...opts,
        networkDelay: this.simDelay,
        seedPrice: this.seedPrice(this.symbol),
        warmupSec: this.simWarmup,
      });
    } else {
      this.feed = new LIVE_FEEDS[venue](opts);
      if (this.autoFallback) {
        this.fallbackTimer = setTimeout(() => {
          if (gen === this.gen && !this.gotData) this.#fallback('No market data received');
        }, this.liveTimeoutMs);
      }
    }
    this.feed.start();
  }

  #fallback(reason) {
    const venue = this.exchange;
    this.stop();
    // Start the simulator first so listeners can already query its history.
    this.#run('sim');
    this.emit('fallback', { exchange: venue, reason });
  }
}
