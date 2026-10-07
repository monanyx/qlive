import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandleSeries, resampleBars } from '../assets/js/market/candles.js';

test('trades fold into OHLCV bars per interval', () => {
  const c = new CandleSeries(60);
  const t0 = 1_700_000_040_000; // 12:34:00 exactly → bucket boundary
  c.addTrade(100, 1, t0);
  c.addTrade(105, 2, t0 + 10_000);
  c.addTrade(95, 1, t0 + 20_000);
  const r = c.addTrade(101, 0.5, t0 + 59_999);
  assert.equal(r.isNew, false);
  assert.deepEqual(c.last, { time: t0 / 1000, open: 100, high: 105, low: 95, close: 101, volume: 4.5 });
  const n = c.addTrade(102, 1, t0 + 60_000);
  assert.equal(n.isNew, true);
  assert.equal(c.bars.length, 2);
  assert.equal(c.last.time, t0 / 1000 + 60);
});

test('late trades older than the current bar are ignored', () => {
  const c = new CandleSeries(1);
  c.addTrade(10, 1, 5_000);
  assert.equal(c.addTrade(11, 1, 3_000), null);
  assert.equal(c.bars.length, 1);
});

test('maxBars caps memory', () => {
  const c = new CandleSeries(1, 10);
  for (let i = 0; i < 50; i++) c.addTrade(i, 1, i * 1000);
  assert.equal(c.bars.length, 10);
  assert.equal(c.bars[0].time, 40);
});

test('mergeHistory prepends older bars and merges the overlap', () => {
  const c = new CandleSeries(60);
  c.addTrade(110, 1, 180_000);
  c.mergeHistory([
    { time: 60, open: 100, high: 101, low: 99, close: 100, volume: 5 },
    { time: 120, open: 100, high: 104, low: 98, close: 103, volume: 6 },
    { time: 180, open: 103, high: 108, low: 102, close: 107, volume: 7 },
  ]);
  assert.deepEqual(
    c.bars.map((b) => b.time),
    [60, 120, 180],
  );
  assert.deepEqual(c.last, { time: 180, open: 103, high: 110, low: 102, close: 110, volume: 7 });
});

test('resampleBars aggregates to coarser intervals', () => {
  const bars = [0, 60, 120, 180, 240, 300].map((t, i) => ({
    time: t,
    open: i,
    high: i + 1,
    low: i - 1,
    close: i + 0.5,
    volume: 1,
  }));
  const r = resampleBars(bars, 300);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { time: 0, open: 0, high: 5, low: -1, close: 4.5, volume: 5 });
  assert.deepEqual(r[1], { time: 300, open: 5, high: 6, low: 4, close: 5.5, volume: 1 });
});
