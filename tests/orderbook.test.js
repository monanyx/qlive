import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook, BookSide } from '../assets/js/market/orderbook.js';

test('BookSide keeps bids descending and asks ascending', () => {
  const bids = new BookSide(true);
  const asks = new BookSide(false);
  for (const p of [100, 102, 99, 101]) {
    bids.set(p, 1);
    asks.set(p + 10, 1);
  }
  assert.deepEqual(bids.prices, [102, 101, 100, 99]);
  assert.deepEqual(asks.prices, [109, 110, 111, 112]);
  assert.equal(bids.best(), 102);
  assert.equal(asks.best(), 109);
  assert.equal(bids.worst(), 99);
});

test('set with size 0 deletes a level; updates keep ordering', () => {
  const s = new BookSide(false);
  s.set(10, 1);
  s.set(11, 2);
  s.set(12, 3);
  s.set(11, 0);
  assert.deepEqual(s.prices, [10, 12]);
  s.set(12, 5);
  assert.equal(s.get(12), 5);
  assert.equal(s.length, 2);
  assert.equal(s.delete(99), false);
});

test('snapshot + deltas produce the expected book', () => {
  const b = new OrderBook();
  b.snapshot(
    [
      [99, 1],
      [98, 2],
    ],
    [
      [101, 1],
      [102, 3],
    ],
  );
  assert.equal(b.bestBid, 99);
  assert.equal(b.bestAsk, 101);
  assert.equal(b.mid, 100);
  assert.equal(b.spread, 2);
  assert.ok(Math.abs(b.spreadBps - 200) < 1e-9);
  b.update('bid', 100, 4);
  b.update('ask', 101, 0);
  assert.equal(b.bestBid, 100);
  assert.equal(b.bestAsk, 102);
  assert.equal(b.isCrossed, false);
  b.update('bid', 103, 1);
  assert.equal(b.isCrossed, true);
});

test('aggregate groups bids down and asks up without straddling the spread', () => {
  const b = new OrderBook();
  b.snapshot(
    [
      [100.4, 1],
      [100.1, 2],
      [99.9, 3],
    ],
    [
      [100.6, 1],
      [100.9, 2],
      [101.2, 4],
    ],
  );
  assert.deepEqual(b.bids.aggregate(10, 1), [
    [100, 3],
    [99, 3],
  ]);
  assert.deepEqual(b.asks.aggregate(10, 1), [
    [101, 3],
    [102, 4],
  ]);
  assert.deepEqual(b.asks.aggregate(1, 1), [[101, 3]]);
});

test('aggregate handles fractional steps without float noise', () => {
  const s = new BookSide(true);
  s.load([
    [0.12347, 1],
    [0.12341, 1],
    [0.12339, 1],
  ]);
  assert.deepEqual(s.aggregate(5, 0.0001), [
    [0.1234, 2],
    [0.1233, 1],
  ]);
});

test('truncate, imbalance and depth curve', () => {
  const b = new OrderBook();
  b.snapshot(
    [
      [99, 3],
      [98, 1],
      [97, 1],
    ],
    [
      [101, 1],
      [102, 1],
      [103, 1],
    ],
  );
  assert.ok(Math.abs(b.imbalance(3) - (5 - 3) / 8) < 1e-12);
  const d = b.depthCurve(0.025);
  assert.deepEqual(d.bids, [
    [99, 3],
    [98, 4],
  ]);
  assert.deepEqual(d.asks, [
    [101, 1],
    [102, 2],
  ]);
  b.truncate(1);
  assert.equal(b.bids.length, 1);
  assert.equal(b.asks.length, 1);
  assert.equal(b.bids.get(98), 0);
});

test('large random workload stays sorted and consistent', () => {
  const s = new BookSide(true);
  const ref = new Map();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 20000; i++) {
    const p = Math.round(rnd() * 2000) / 10;
    const size = rnd() < 0.3 ? 0 : rnd();
    s.set(p, size);
    if (size > 0) ref.set(p, size);
    else ref.delete(p);
  }
  const expected = [...ref.keys()].sort((a, b) => b - a);
  assert.deepEqual(s.prices, expected);
  for (const p of expected) assert.equal(s.get(p), ref.get(p));
});
