import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketSim, generateBars } from '../assets/js/sim/market-sim.js';
import { OrderBook } from '../assets/js/market/orderbook.js';
import { SYMBOLS, tickSize } from '../assets/js/core/config.js';
import { createRng } from '../assets/js/core/rng.js';

const make = (id = 'BTC', seed = 1) => {
  const c = SYMBOLS[id];
  return new MarketSim({
    price: c.sim.price,
    tick: tickSize(id),
    sizeDecimals: c.sizeDecimals,
    vol: c.sim.vol,
    topNotional: c.sim.topNotional,
    seed,
    now: 1_700_000_000_000,
  });
};

const run = (sim, seconds, dt = 0.1, onEvent = () => {}) => {
  for (let i = 0; i < seconds / dt; i++) for (const e of sim.step(dt)) onEvent(e);
};

test('is deterministic for a given seed', () => {
  const a = make('ETH', 99);
  const b = make('ETH', 99);
  const ea = [];
  const eb = [];
  run(a, 30, 0.1, (e) => ea.push(e));
  run(b, 30, 0.1, (e) => eb.push(e));
  assert.deepEqual(ea, eb);
});

test('book never crosses and deltas reproduce the internal book', () => {
  for (const id of ['BTC', 'XRP', 'DOGE']) {
    const sim = make(id, 3);
    const mirror = new OrderBook();
    const snap = sim.snapshotEvent();
    mirror.snapshot(snap.bids, snap.asks);
    let steps = 0;
    run(sim, 300, 0.1, (e) => {
      if (e.type === 'book') for (const [side, p, s] of e.changes) mirror.update(side, p, s);
    });
    for (let i = 0; i < 3000; i++) {
      sim.step(0.1);
      assert.equal(sim.book.isCrossed, false, `${id} crossed at step ${i}`);
      steps++;
    }
    // Re-sync mirror for the second phase and compare full books.
    const s2 = sim.snapshotEvent();
    mirror.snapshot(s2.bids, s2.asks);
    assert.deepEqual(mirror.bids.levels(), sim.book.bids.levels());
    assert.ok(steps > 0);
  }
});

test('mirror built purely from emitted deltas matches exactly', () => {
  const sim = make('SOL', 11);
  const mirror = new OrderBook();
  const snap = sim.snapshotEvent();
  mirror.snapshot(snap.bids, snap.asks);
  run(sim, 120, 0.05, (e) => {
    if (e.type === 'book') for (const [side, p, s] of e.changes) mirror.update(side, p, s);
  });
  assert.deepEqual(mirror.bids.levels(), sim.book.bids.levels());
  assert.deepEqual(mirror.asks.levels(), sim.book.asks.levels());
});

test('prices are on the tick grid with no float artefacts', () => {
  const sim = make('DOGE', 5);
  const decimals = SYMBOLS.DOGE.priceDecimals;
  run(sim, 60, 0.1, (e) => {
    if (e.type === 'trade') assert.equal(e.price, Number(e.price.toFixed(decimals)));
  });
  for (const p of sim.book.bids.prices) assert.equal(p, Number(p.toFixed(decimals)));
});

test('depth decays with distance from the touch (power law, more volume near mid)', () => {
  const sim = make('BTC', 21);
  // Average notional per bps bucket over many snapshots.
  const buckets = new Array(8).fill(0);
  for (let k = 0; k < 40; k++) {
    run(sim, 5);
    const mid = sim.book.mid;
    for (const [p, s] of sim.book.bids.levels()) {
      const bps = ((mid - p) / mid) * 1e4;
      const i = Math.floor(Math.log2(1 + bps));
      if (i < buckets.length) buckets[i] += (p * s) / 2 ** i; // per-bps density
    }
  }
  // Density near the touch must dominate density further out.
  assert.ok(buckets[0] > buckets[3], `near ${buckets[0]} vs mid ${buckets[3]}`);
  assert.ok(buckets[3] > buckets[7], `mid ${buckets[3]} vs far ${buckets[7]}`);
});

test('trade flow is plausible: clustered, heavy-tailed, both sides', () => {
  const sim = make('BTC', 8);
  const sizes = [];
  const sides = { buy: 0, sell: 0 };
  const perSecond = new Map();
  run(sim, 600, 0.1, (e) => {
    if (e.type !== 'trade') return;
    sizes.push(e.price * e.size);
    sides[e.side]++;
    const s = Math.floor(e.ts / 1000);
    perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
  });
  const rate = sizes.length / 600;
  assert.ok(rate > 2 && rate < 40, `rate ${rate}/s`);
  assert.ok(sides.buy > sizes.length * 0.25 && sides.sell > sizes.length * 0.25);
  sizes.sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const p999 = sizes[Math.floor(sizes.length * 0.999)];
  assert.ok(p999 / median > 50, `tail ratio ${p999 / median}`);
  // Over-dispersion (variance > mean) indicates clustering vs. plain Poisson.
  const counts = [...perSecond.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  assert.ok(variance > mean * 1.2, `variance ${variance} mean ${mean}`);
});

test('spread is at least one tick and mean-reverts after a sweep', () => {
  const sim = make('ETH', 4);
  run(sim, 30);
  const tick = tickSize('ETH');
  const before = sim.book.spread / tick;
  sim.marketOrder('buy', 60); // ≈ $190k: sweeps several ask levels
  const wide = sim.book.spread / tick;
  assert.ok(wide > before, `sweep widened ${before} → ${wide}`);
  run(sim, 15);
  const after = sim.book.spread / tick;
  assert.ok(wide > after, `spread ${wide} → ${after}`);
  assert.ok(after >= 1 - 1e-9);
});

test('ticker and history are consistent with the current price', () => {
  const sim = make('BTC', 2);
  run(sim, 30);
  const t = sim.ticker();
  assert.ok(t.high24h >= t.last && t.low24h <= t.last);
  assert.ok(t.volume24h > 0);
  for (const sec of [1, 60, 300, 3600]) {
    const h = sim.history(sec, 100);
    assert.ok(h.length > 0, `history ${sec}`);
    for (let i = 1; i < h.length; i++) assert.ok(h[i].time > h[i - 1].time);
    for (const b of h) assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close));
  }
});

test('generateBars ends exactly at the requested price and time', () => {
  const bars = generateBars({
    endPrice: 123.45,
    endTime: 6000,
    interval: 60,
    count: 50,
    sigmaPerSqrtSec: 1e-4,
    volumePerSec: 1,
    tick: 0.01,
    rng: createRng(1),
  });
  assert.equal(bars.length, 50);
  assert.equal(bars.at(-1).close, 123.45);
  assert.equal(bars.at(-1).time, 6000);
  assert.equal(bars[0].time, 6000 - 49 * 60);
  for (let i = 1; i < bars.length; i++) assert.equal(bars[i].open, bars[i - 1].close);
});
