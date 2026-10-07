import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyMonitor, RateCounter, RingBuffer, quantile, summarize } from '../assets/js/metrics/latency.js';
import {
  fmtBps,
  fmtCompact,
  fmtMs,
  fmtPct,
  fmtPrice,
  fmtUsd,
  fmtUsdSigned,
  roundTo,
} from '../assets/js/core/format.js';
import { decimalsOf, tickSize, SYMBOLS } from '../assets/js/core/config.js';
import { createRng } from '../assets/js/core/rng.js';
import { Emitter } from '../assets/js/core/emitter.js';
import { Market } from '../assets/js/market/market.js';

test('ring buffer keeps the most recent values in order', () => {
  const r = new RingBuffer(3);
  [1, 2, 3, 4, 5].forEach((v) => r.push(v));
  assert.deepEqual([...r.values()], [3, 4, 5]);
  assert.equal(r.last(), 5);
});

test('quantiles and summary', () => {
  const sorted = Float64Array.from([1, 2, 3, 4, 5]);
  assert.equal(quantile(sorted, 0.5), 3);
  assert.equal(quantile(sorted, 0.25), 2);
  const s = summarize([5, 1, 4, 2, 3]);
  assert.equal(s.p50, 3);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
  assert.equal(summarize([]).count, 0);
});

test('rate counter averages complete seconds in its window', () => {
  let now = 10_000;
  const r = new RateCounter(2, () => now);
  r.add(4);
  now += 1000;
  r.add(6);
  now += 1000;
  assert.equal(r.rate(), 5);
});

test('latency monitor records stages and builds histograms', () => {
  const m = new LatencyMonitor({ capacity: 8 });
  for (const v of [0.01, 0.02, 1, 10, 100]) m.record('parse', v);
  const s = m.stats('parse');
  assert.equal(s.count, 5);
  assert.equal(s.p50, 1);
  const h = m.histogram('parse', 5, 0.001, 1000);
  assert.equal(
    h.reduce((a, b) => a + b, 0),
    5,
  );
  assert.equal(
    m.measure('apply', () => 42),
    42,
  );
  assert.equal(m.stats('apply').count, 1);
});

test('formatting helpers', () => {
  assert.equal(fmtPrice(64250.5, 2), '64,250.50');
  assert.equal(fmtUsd(-12.5), '−$12.50');
  assert.equal(fmtUsdSigned(3), '+$3.00');
  assert.equal(fmtCompact(1_234_567), '1.23M');
  assert.equal(fmtPct(-1.234), '−1.23%');
  assert.equal(fmtBps(1.25), '1.3 bps');
  assert.equal(fmtMs(0.0456), '46 µs');
  assert.equal(fmtMs(3.14159), '3.14 ms');
  assert.equal(fmtPrice(NaN), '—');
});

test('roundTo avoids binary float artefacts', () => {
  assert.equal(roundTo(0.123456, 0.0001, 'floor'), 0.1234);
  assert.equal(roundTo(0.1 + 0.2, 0.1), 0.3);
  assert.equal(roundTo(64251, 50, 'ceil'), 64300);
});

test('decimalsOf / tickSize are exact even for 10 ** -5', () => {
  assert.equal(decimalsOf(10 ** -5), 5);
  assert.equal(decimalsOf(0.05), 2);
  assert.equal(decimalsOf(50), 0);
  for (const id of Object.keys(SYMBOLS)) assert.equal(decimalsOf(tickSize(id)), SYMBOLS[id].priceDecimals);
  assert.equal(tickSize('DOGE'), 0.00001);
});

test('rng is deterministic and roughly standard normal', () => {
  const a = createRng(123);
  const b = createRng(123);
  const xs = Array.from({ length: 20000 }, () => a.normal());
  assert.equal(xs[0], b.normal());
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.03);
  assert.ok(Math.abs(sd - 1) < 0.03);
  const p = Array.from({ length: 5000 }, () => a.poisson(3));
  assert.ok(Math.abs(p.reduce((s, x) => s + x, 0) / p.length - 3) < 0.1);
});

test('emitter isolates listener errors and supports once/off', () => {
  const e = new Emitter();
  const seen = [];
  const orig = console.error;
  console.error = () => {};
  e.on('x', () => {
    throw new Error('boom');
  });
  e.once('x', (v) => seen.push(`once:${v}`));
  const off = e.on('x', (v) => seen.push(v));
  e.emit('x', 1);
  off();
  e.emit('x', 2);
  console.error = orig;
  assert.deepEqual(seen, ['once:1', 1]);
});

test('market applies events, truncates Kraken-style books and flags crossed books', () => {
  const m = new Market({ symbol: 'BTC', latency: new LatencyMonitor() });
  m.ingest({
    type: 'book',
    action: 'snapshot',
    bids: [
      [99, 1],
      [98, 1],
      [97, 1],
    ],
    asks: [
      [101, 1],
      [102, 1],
    ],
    depth: 2,
  });
  assert.equal(m.book.bids.length, 2);
  m.ingest({ type: 'trade', price: 100, size: 2, side: 'buy', ts: 1, recv: 5 });
  m.ingest({ type: 'trade', price: 100.5, size: 1, side: 'sell', ts: 2, recv: 6 });
  assert.equal(m.last, 100.5);
  assert.equal(m.prevPrice, 100);
  m.ingest({ type: 'ticker', open24h: 50, high24h: 100, low24h: 40 });
  assert.equal(m.change24h, 101);
  assert.equal(m.ticker.high24h, 100.5, 'high includes prints seen since the ticker');
  const f = m.flow(Infinity, 10);
  assert.equal(f.buy, 2);
  assert.equal(f.sell, 1);
  assert.equal(m.latency.stats('feed').count, 2);
});
