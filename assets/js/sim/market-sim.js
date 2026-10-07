import { createRng } from '../core/rng.js';
import { decimalsOf } from '../core/config.js';
import { OrderBook } from '../market/orderbook.js';
import { CandleSeries } from '../market/candles.js';

/**
 * QuantumLive market microstructure simulator.
 *
 * A stylised but internally consistent limit-order-book model:
 *
 *  • Fair price   — geometric Brownian motion with stochastic (log-OU)
 *                   volatility and rare Poisson jumps that also spike vol.
 *  • Spread       — Ornstein–Uhlenbeck process in ticks whose mean widens
 *                   with volatility; sweeps open transient gaps that market
 *                   makers refill with time constant `refillTau`.
 *  • Depth        — resting size decays with distance d from the touch as a
 *                   power law  q(d) ∝ (1 + d/x₀)^−α  (more volume near mid),
 *                   with lognormal noise and occasional "walls" on round
 *                   price levels. Orders arrive, resize and cancel randomly.
 *  • Trades       — self-exciting Hawkes arrivals (volatility clustering),
 *                   Pareto-distributed notional (heavy-tailed whale prints),
 *                   order side tilted by short-term momentum. Market orders
 *                   walk the book and leave square-root-law permanent impact.
 *  • Liquidations — forced orders triggered by sharp moves; they hit the book
 *                   as market orders, so cascades emerge naturally.
 *
 * The simulator is deterministic for a given seed and emits the same
 * normalised events as the live exchange adapters.
 */

const SECONDS_PER_YEAR = 365 * 24 * 3600;

export const SIM_DEFAULTS = {
  // Volatility (log-OU around the symbol's long-run annualised vol)
  volKappa: 1 / 240, // mean reversion speed of log-vol (1/s)
  volOfVol: 0.03, // diffusion of log-vol (per √s) → stationary sd ≈ 0.33
  jumpRate: 1 / 900, // price jumps per second
  jumpSigma: 0.0018, // sd of jump log-return
  jumpVolKick: 0.6, // log-vol increase after a jump

  // Spread (ticks)
  spreadTicks: 1.4, // long-run mean spread in calm markets
  spreadVolSens: 1.6, // elasticity of the mean spread to vol
  spreadKappa: 2.0, // OU mean reversion (1/s)
  spreadEta: 0.9, // OU noise (ticks per √s)
  spreadMaxTicks: 40,
  refillTau: 0.6, // mean seconds for makers to re-quote a touch emptied by a sweep

  // Depth profile
  levels: 360, // max price levels kept per side
  depthAlpha: 0.6, // power-law exponent of size vs distance
  depthX0Bps: 0.8, // distance scale of the power law (bps)
  sizeSigma: 0.6, // lognormal noise of level sizes
  spawnRate: 60, // new resting orders per second per side
  spawnBeta: 0.55, // tail exponent of the arrival-distance distribution
  spawnX0Bps: 1.2,
  maxDistBps: 140,
  cancelRate: 0.35, // resize/cancel events per level per second
  cancelShare: 0.35, // share of those events that fully cancel the level
  wallProb: 0.035,
  wallMult: [4, 14],
  pickOffProb: 0.06, // share of stale quotes that trade (vs. cancel) when fair moves through them

  // Trades
  tradeRate: 3, // Hawkes baseline intensity (taker orders / s)
  hawkesAlpha: 0.9, // intensity jump per taker order
  hawkesBeta: 1.5, // intensity decay (1/s); branching ratio = α/β = 0.6
  tradeMinFrac: 0.0035, // Pareto scale as a fraction of top-of-book notional
  tradeAlpha: 1.22, // Pareto shape (lower = fatter tail)
  tradeMaxFrac: 40, // cap as a multiple of top-of-book notional
  momentumTau: 4, // seconds of return memory that tilts order side
  momentumTilt: 0.22,
  impactK: 0.45, // permanent impact (bps) per √(notional / top notional)

  // Liquidations
  liqBaseRate: 1 / 45,
  liqWindowSec: 15,
  liqZ: 2.2,
};

/**
 * Synthesise OHLCV bars ending at `endPrice` by walking backwards in time.
 * Per-bar vol is itself random so the history shows volatility clustering.
 */
export function generateBars({ endPrice, endTime, interval, count, sigmaPerSqrtSec, volumePerSec, tick, rng }) {
  const dec = decimalsOf(tick);
  const r2 = (p) => Number((Math.round(p / tick) * tick).toFixed(dec));
  const bars = new Array(count);
  let close = endPrice;
  let regime = 0;
  const base = sigmaPerSqrtSec * Math.sqrt(interval);
  for (let i = count - 1; i >= 0; i--) {
    regime = 0.97 * regime + 0.24 * rng.normal();
    const sd = base * Math.exp(0.45 * regime);
    const r = sd * rng.normal();
    const open = close * Math.exp(-r);
    const high = Math.max(open, close) * Math.exp(Math.abs(rng.normal()) * sd * 0.6);
    const low = Math.min(open, close) * Math.exp(-Math.abs(rng.normal()) * sd * 0.6);
    const activity = Math.exp(0.45 * rng.normal()) * (0.6 + Math.abs(r) / (base || 1));
    bars[i] = {
      time: endTime - (count - 1 - i) * interval,
      open: r2(open),
      high: r2(high),
      low: r2(low),
      close: r2(close),
      volume: volumePerSec * interval * activity,
    };
    close = open;
  }
  return bars;
}

export class MarketSim {
  /**
   * @param {object} o
   * @param {number} o.price         starting fair price
   * @param {number} o.tick          price increment
   * @param {number} [o.sizeDecimals]
   * @param {number} [o.vol]         long-run annualised volatility (e.g. 0.6)
   * @param {number} [o.topNotional] mean resting notional at the touch
   * @param {number} [o.seed]
   * @param {object} [o.params]      overrides for SIM_DEFAULTS
   * @param {number} [o.now]         simulation start (ms since epoch)
   */
  constructor({ price, tick, sizeDecimals = 4, vol = 0.6, topNotional = 30_000, seed, params = {}, now = Date.now() }) {
    this.P = { ...SIM_DEFAULTS, ...params };
    this.rng = createRng(seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.tick = tick;
    this.dec = decimalsOf(tick);
    this.sizeDec = Math.min(8, sizeDecimals + 3);
    this.vol = vol;
    this.topNotional = topNotional;
    this.fair = price;
    this.h = 0;
    this.spread = this.P.spreadTicks;
    this.excite = 0;
    this.mom = 0;
    this.clock = now;
    this.tradeId = 1;
    this.book = new OrderBook();
    this.changes = new Map();
    this.out = [];
    this.fairTape = []; // [clockMs, fair] sampled each second (liquidation trigger)
    this.lastSample = 0;
    this.lastTicker = 0;
    // After a sweep empties the touch, makers wait before re-quoting it.
    this.recoverAt = { bid: 0, ask: 0 };
    this.wallStep = Math.max(tick, Math.pow(10, Math.floor(Math.log10(price))) / 100);

    const sigma = vol / Math.sqrt(SECONDS_PER_YEAR);
    const meanTrade = (this.P.tradeAlpha * this.P.tradeMinFrac * topNotional) / (this.P.tradeAlpha - 1);
    const rate = this.P.tradeRate / (1 - this.P.hawkesAlpha / this.P.hawkesBeta);
    this.volumePerSec = (meanTrade * rate) / price;

    const nowSec = Math.floor(now / 1000);
    this.minutes = new CandleSeries(60, 4400);
    this.minutes.setHistory(
      generateBars({
        endPrice: price,
        endTime: nowSec - (nowSec % 60),
        interval: 60,
        count: 4320, // 3 days of 1-minute bars
        sigmaPerSqrtSec: sigma,
        volumePerSec: this.volumePerSec,
        tick,
        rng: this.rng,
      }),
    );
    this.#seedBook();
  }

  // ---------------------------------------------------------------- helpers

  px(idx) {
    return Number((idx * this.tick).toFixed(this.dec));
  }

  idx(price) {
    return Math.round(price / this.tick);
  }

  #qty(q) {
    return Number(q.toFixed(this.sizeDec));
  }

  get sigma() {
    return (this.vol * Math.exp(this.h)) / Math.sqrt(SECONDS_PER_YEAR);
  }

  /** Mean-ish resting size (base units) at `distBps` from the touch. */
  #levelSize(distBps, allowWall = true) {
    const P = this.P;
    const shape = Math.pow(1 + distBps / P.depthX0Bps, -P.depthAlpha);
    let notional = this.topNotional * shape * this.rng.lognormal(-0.5 * P.sizeSigma ** 2, P.sizeSigma);
    if (allowWall && this.rng.next() < P.wallProb) notional *= this.rng.uniform(...P.wallMult);
    return Math.max(this.#qty(notional / this.fair), 10 ** -this.sizeDec);
  }

  /** Arrival distance (bps) of a new resting order — dense near the touch. */
  #arrivalDistance() {
    const { spawnX0Bps: x0, spawnBeta: b, maxDistBps } = this.P;
    return Math.min(maxDistBps, x0 * (Math.pow(1 - this.rng.next(), -1 / b) - 1));
  }

  #bpsToTicks(bps) {
    return Math.max(0, Math.round((bps * 1e-4 * this.fair) / this.tick));
  }

  #set(side, price, size) {
    const s = size > 10 ** -this.sizeDec / 2 ? this.#qty(size) : 0;
    this.book.update(side, price, s, this.clock);
    this.changes.set(`${side}:${price}`, [side, price, s]);
  }

  #targets() {
    const f = this.fair / this.tick;
    const half = this.spread / 2;
    const bid = Math.floor(f - half);
    const ask = Math.max(bid + 1, Math.ceil(f + half));
    return { bid, ask };
  }

  #seedBook() {
    const { bid, ask } = this.#targets();
    for (const side of ['bid', 'ask']) {
      const sign = side === 'bid' ? -1 : 1;
      const touch = side === 'bid' ? bid : ask;
      this.#set(side, this.px(touch), this.#levelSize(0, false));
      for (let i = 0; i < this.P.levels * 0.9; i++) {
        const d = this.#arrivalDistance();
        const p = this.px(touch + sign * this.#bpsToTicks(d));
        this.#set(side, p, this.book.side(side).get(p) + this.#levelSize(d));
      }
    }
    this.changes.clear();
  }

  // ------------------------------------------------------------- dynamics

  /** Advance the simulation by `dt` seconds and return the emitted events. */
  step(dt) {
    const P = this.P;
    const rng = this.rng;
    this.clock += dt * 1000;

    // 1 — stochastic volatility (log-OU)
    this.h += -P.volKappa * this.h * dt + P.volOfVol * Math.sqrt(dt) * rng.normal();
    this.h = Math.max(-1.5, Math.min(2, this.h));
    const sigma = this.sigma;

    // 2 — jumps
    let jump = 0;
    if (rng.next() < P.jumpRate * dt) {
      jump = rng.normal() * P.jumpSigma;
      this.h += P.jumpVolKick;
    }

    // 3 — fair price (GBM)
    const z = rng.normal();
    const ret = sigma * Math.sqrt(dt) * z - 0.5 * sigma * sigma * dt + jump;
    this.fair *= Math.exp(ret);
    const a = 1 - Math.exp(-dt / P.momentumTau);
    this.mom += (z - this.mom) * a;

    // 4 — spread (OU in ticks, mean widens with vol)
    const target = P.spreadTicks * Math.pow(Math.exp(this.h), P.spreadVolSens);
    this.spread += P.spreadKappa * (target - this.spread) * dt + P.spreadEta * Math.sqrt(dt) * rng.normal();
    this.spread = Math.max(1, Math.min(P.spreadMaxTicks, this.spread));

    this.#requote();
    this.#churn(dt);
    this.#trades(dt);
    this.#liquidations(dt, sigma);

    // Bookkeeping: fair tape for liquidation triggers, periodic ticker.
    if (this.clock - this.lastSample >= 1000) {
      this.lastSample = this.clock;
      this.fairTape.push([this.clock, this.fair]);
      if (this.fairTape.length > 120) this.fairTape.shift();
    }
    if (this.clock - this.lastTicker >= 1000) {
      this.lastTicker = this.clock;
      this.out.push(this.ticker());
    }
    return this.#flush();
  }

  /** Makers re-centre quotes on the fair price; stale quotes are picked off or pulled. */
  #requote() {
    const { bid, ask } = this.#targets();
    const bidP = this.px(bid);
    const askP = this.px(ask);
    const asks = this.book.asks;
    const bids = this.book.bids;

    while (asks.length && asks.best() < askP) {
      const p = asks.best();
      if (this.rng.next() < this.P.pickOffProb) this.#trade('buy', p, asks.get(p) * this.rng.uniform(0.02, 0.2));
      this.#set('ask', p, 0);
    }
    while (bids.length && bids.best() > bidP) {
      const p = bids.best();
      if (this.rng.next() < this.P.pickOffProb) this.#trade('sell', p, bids.get(p) * this.rng.uniform(0.02, 0.2));
      this.#set('bid', p, 0);
    }

    // Makers quote the target touch continuously — except right after a sweep,
    // which leaves a transient gap (spread widening) until `recoverAt`.
    if (!(bids.best() >= bidP) && this.clock >= this.recoverAt.bid) this.#set('bid', bidP, this.#levelSize(0, false));
    if (!(asks.best() <= askP) && this.clock >= this.recoverAt.ask) this.#set('ask', askP, this.#levelSize(0, false));
  }

  /** Random arrivals, resizes and cancellations of resting liquidity. */
  #churn(dt) {
    const P = this.P;
    const rng = this.rng;
    const { bid, ask } = this.#targets();

    for (const side of ['bid', 'ask']) {
      const book = this.book.side(side);
      const sign = side === 'bid' ? -1 : 1;
      const touch = side === 'bid' ? bid : ask;

      const n = rng.poisson(P.spawnRate * dt);
      for (let i = 0; i < n; i++) {
        const d = this.#arrivalDistance();
        let p = this.px(touch + sign * Math.max(0, this.#bpsToTicks(d)));
        // Walls gravitate to round numbers.
        if (rng.next() < P.wallProb) {
          const w = this.wallStep;
          const r = side === 'bid' ? Math.floor(p / w) * w : Math.ceil(p / w) * w;
          p = this.px(this.idx(r));
        }
        const opp = side === 'bid' ? this.book.asks.best() : this.book.bids.best();
        if (Number.isFinite(opp) && (side === 'bid' ? p >= opp : p <= opp)) continue;
        this.#set(side, p, book.get(p) + this.#levelSize(d));
      }

      // Resize / cancel — sample events rather than iterating every level.
      const events = rng.poisson(P.cancelRate * dt * book.length);
      for (let i = 0; i < events && book.length; i++) {
        // Skew toward the touch less than arrivals do: uniform over levels.
        const p = book.prices[Math.floor(rng.next() * book.length)];
        if (rng.next() < P.cancelShare) this.#set(side, p, 0);
        else this.#set(side, p, book.get(p) * rng.lognormal(-0.06125, 0.35));
      }

      // Keep the level count bounded.
      while (book.length > P.levels) this.#set(side, book.worst(), 0);
    }
  }

  /** Hawkes-clustered taker orders that walk the book. */
  #trades(dt) {
    const P = this.P;
    this.excite *= Math.exp(-P.hawkesBeta * dt);
    const n = this.rng.poisson((P.tradeRate + this.excite) * dt);
    for (let i = 0; i < n; i++) {
      const pBuy = 0.5 + P.momentumTilt * Math.tanh(2 * this.mom);
      const side = this.rng.next() < pBuy ? 'buy' : 'sell';
      const notional = Math.min(
        this.rng.pareto(P.tradeMinFrac * this.topNotional, P.tradeAlpha),
        P.tradeMaxFrac * this.topNotional,
      );
      this.marketOrder(side, notional / this.fair);
      this.excite += P.hawkesAlpha;
    }
  }

  /** Forced liquidations after sharp moves (plus a small background rate). */
  #liquidations(dt, sigma) {
    const P = this.P;
    const past = this.fairTape.find(([t]) => t >= this.clock - P.liqWindowSec * 1000);
    let rate = P.liqBaseRate;
    let dir = this.rng.next() < 0.5 ? -1 : 1;
    if (past) {
      const r = Math.log(this.fair / past[1]);
      const zMove = r / (sigma * Math.sqrt(P.liqWindowSec));
      dir = Math.sign(r) || dir;
      if (Math.abs(zMove) > P.liqZ) rate += 0.35 * (Math.abs(zMove) - P.liqZ);
    }
    if (this.rng.next() >= rate * dt) return;
    // Price fell → longs are force-sold; price rose → shorts are force-bought.
    const side = dir < 0 ? 'sell' : 'buy';
    const notional = Math.min(this.rng.pareto(0.08 * this.topNotional, 1.3), 30 * this.topNotional);
    const qty = notional / this.fair;
    const avg = this.marketOrder(side, qty);
    this.out.push({
      type: 'liquidation',
      side: side === 'sell' ? 'long' : 'short',
      price: avg || this.fair,
      size: this.#qty(qty),
      ts: this.clock,
    });
  }

  #trade(side, price, size) {
    const q = this.#qty(size);
    if (!(q > 0)) return;
    this.out.push({ type: 'trade', id: this.tradeId++, price, size: q, side, ts: this.clock });
    this.minutes.addTrade(price, q, this.clock);
  }

  /**
   * Execute a taker order of `qty` base units against the simulated book.
   * Emits one trade print per price level touched (like aggTrade feeds) and
   * applies square-root-law permanent impact to the fair price.
   * Returns the volume-weighted average fill price.
   */
  marketOrder(side, qty) {
    const book = side === 'buy' ? this.book.asks : this.book.bids;
    const bookSide = side === 'buy' ? 'ask' : 'bid';
    let remaining = qty;
    let notional = 0;
    let filled = 0;
    const eps = 10 ** -this.sizeDec;
    let swept = false;
    while (remaining > eps && book.length) {
      const p = book.best();
      const s = book.get(p);
      const take = Math.min(s, remaining);
      this.#trade(side, p, take);
      this.#set(bookSide, p, s - take);
      if (take >= s) swept = true;
      remaining -= take;
      notional += take * p;
      filled += take;
    }
    if (swept) this.recoverAt[bookSide] = this.clock + this.rng.exponential(this.P.refillTau * 1000);
    if (filled > 0) {
      const impactBps = this.P.impactK * Math.sqrt(notional / this.topNotional);
      this.fair *= 1 + (side === 'buy' ? 1 : -1) * impactBps * 1e-4;
    }
    return filled > 0 ? notional / filled : NaN;
  }

  #flush() {
    if (this.changes.size) {
      this.out.push({ type: 'book', action: 'delta', changes: [...this.changes.values()], ts: this.clock });
      this.changes.clear();
    }
    const out = this.out;
    this.out = [];
    return out;
  }

  // ------------------------------------------------------------ snapshots

  snapshotEvent() {
    return {
      type: 'book',
      action: 'snapshot',
      bids: this.book.bids.levels(),
      asks: this.book.asks.levels(),
      ts: this.clock,
    };
  }

  /** Rolling 24 h statistics from the synthetic + live minute bars. */
  ticker() {
    const bars = this.minutes.bars;
    const cutoff = Math.floor(this.clock / 1000) - 86_400;
    let open = NaN;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (let i = bars.length - 1; i >= 0 && bars[i].time > cutoff; i--) {
      const b = bars[i];
      open = b.open;
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
    }
    const last = this.minutes.last?.close ?? this.fair;
    return { type: 'ticker', last, open24h: open, high24h: high, low24h: low, volume24h: volume, ts: this.clock };
  }

  /** Candle history for the chart at any supported interval. */
  history(intervalSec, count = 500) {
    if (intervalSec < 60) {
      const nowSec = Math.floor(this.clock / 1000);
      return generateBars({
        endPrice: this.minutes.last?.close ?? this.fair,
        endTime: nowSec - 1,
        interval: intervalSec,
        count,
        sigmaPerSqrtSec: this.sigma,
        volumePerSec: this.volumePerSec,
        tick: this.tick,
        rng: this.rng,
      });
    }
    const out = [];
    for (const b of this.minutes.bars) {
      const t = b.time - (b.time % intervalSec);
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, b.high);
        last.low = Math.min(last.low, b.low);
        last.close = b.close;
        last.volume += b.volume;
      } else out.push({ ...b, time: t });
    }
    return out.slice(-count);
  }
}
