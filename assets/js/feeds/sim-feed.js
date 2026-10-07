import { SYMBOLS, tickSize } from '../core/config.js';
import { createRng } from '../core/rng.js';
import { MarketSim } from '../sim/market-sim.js';

/**
 * Drives a MarketSim in real time and delivers its events through the same
 * interface as the WebSocket feeds. Optionally pre-runs `warmupSec` of
 * simulated history so views start populated.
 *
 * With `networkDelay` enabled, each event is delivered after a lognormal
 * delay (median ≈ 30 ms) to emulate a network hop, so the latency monitor
 * shows realistic "feed lag" figures. Delivery order is preserved (like TCP).
 */
export class SimFeed {
  constructor({
    symbol,
    onEvent = () => {},
    onStatus = () => {},
    latency = null,
    networkDelay = true,
    seedPrice,
    seed,
    warmupSec = 0,
  }) {
    this.symbol = symbol;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.latency = latency;
    this.networkDelay = networkDelay;
    this.seedPrice = seedPrice;
    this.seed = seed;
    this.warmupSec = warmupSec;
    this.queue = [];
    this.lastDeliver = 0;
    this.rng = createRng((seed ?? Date.now()) ^ 0x5bd1e995);
  }

  start() {
    const cfg = SYMBOLS[this.symbol];
    this.sim = new MarketSim({
      price: this.seedPrice > 0 ? this.seedPrice : cfg.sim.price,
      tick: tickSize(this.symbol),
      sizeDecimals: cfg.sizeDecimals,
      vol: cfg.sim.vol,
      topNotional: cfg.sim.topNotional,
      seed: this.seed,
      now: Date.now() - this.warmupSec * 1000,
    });
    this.onStatus({ state: 'connecting', detail: 'simulator' });
    this.bootTimer = setTimeout(() => {
      this.onStatus({ state: 'open', detail: 'simulator' });
      const snapshot = this.sim.snapshotEvent();
      snapshot.recv = snapshot.ts;
      this.onEvent(snapshot);
      // Warm-up: replay `warmupSec` of simulated history instantly so views
      // (tape, heatmap, candles) start populated. Flagged `warmup` so the
      // paper engine, alerts and latency stats ignore it.
      for (let t = 0; t < this.warmupSec; t += 0.1) {
        for (const ev of this.sim.step(0.1)) {
          ev.warmup = true;
          ev.recv = ev.ts;
          this.onEvent(ev);
        }
      }
      this.sim.clock = Date.now();
      this.#deliver([this.sim.ticker()]);
      this.onStatus({ state: 'live' });
      this.lastTick = performance.now();
      this.timer = setInterval(() => this.#tick(), 25);
    }, 200);
  }

  stop() {
    clearTimeout(this.bootTimer);
    clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.onStatus({ state: 'closed' });
  }

  resync() {
    if (this.sim) this.#deliver([this.sim.snapshotEvent()]);
  }

  history(intervalSec, count) {
    return this.sim ? this.sim.history(intervalSec, count) : [];
  }

  #tick() {
    const now = performance.now();
    // Cap catch-up after the tab was hidden: don't replay minutes of market.
    let elapsed = Math.min(5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.sim.clock = Date.now() - elapsed * 1000;
    const events = [];
    while (elapsed > 1e-6) {
      const dt = Math.min(0.1, elapsed);
      for (const ev of this.sim.step(dt)) events.push(ev);
      elapsed -= dt;
    }
    if (events.length) this.#deliver(events);
    this.#flush();
  }

  #deliver(events) {
    if (!this.networkDelay) {
      const recv = Date.now();
      for (const ev of events) this.#emit(ev, recv);
      return;
    }
    const delay = this.rng.lognormal(Math.log(30), 0.45);
    const at = Math.max(this.lastDeliver, Date.now() + delay);
    this.lastDeliver = at;
    this.queue.push({ at, events });
  }

  #flush() {
    const now = Date.now();
    while (this.queue.length && this.queue[0].at <= now) {
      const { events } = this.queue.shift();
      for (const ev of events) this.#emit(ev, now);
    }
  }

  #emit(ev, recv) {
    ev.recv = recv;
    if (this.latency) this.latency.message(0, recv);
    this.onEvent(ev);
  }
}
