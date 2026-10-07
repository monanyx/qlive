import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperEngine, walkBook } from '../assets/js/trading/paper-engine.js';
import { PriceAlerts } from '../assets/js/trading/alerts.js';
import { createMemoryStorage } from '../assets/js/core/storage.js';

const book = {
  bids: [
    [99, 1],
    [98, 2],
    [97, 5],
  ],
  asks: [
    [101, 1],
    [102, 2],
    [103, 5],
  ],
  last: 100,
};

const engine = (opts = {}) =>
  new PaperEngine({
    storage: createMemoryStorage(),
    startingCash: 10_000,
    fees: { maker: 0.001, taker: 0.002 },
    now: () => 1_000,
    ...opts,
  });

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('walkBook computes VWAP and respects limits', () => {
  const w = walkBook(book.asks, 2.5, true);
  close(w.filled, 2.5);
  close(w.avg, (101 + 102 * 1.5) / 2.5);
  assert.equal(w.worst, 102);
  const l = walkBook(book.asks, 10, true, 102);
  close(l.filled, 3);
  close(l.remaining, 7);
});

test('market buy walks the book, charges taker fees and builds cost basis', () => {
  const e = engine();
  const r = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'market', qty: 2 }, book);
  assert.equal(r.ok, true);
  assert.equal(r.order.status, 'filled');
  const notional = 101 + 102;
  close(r.order.avgPrice, notional / 2);
  close(e.balance('BTC'), 2);
  close(e.balance('USD'), 10_000 - notional * 1.002);
  close(e.state.cost.BTC, notional * 1.002);
  assert.equal(e.state.fills.length, 2);
  assert.equal(e.state.fills[0].liquidity, 'taker');
});

test('market order is rejected when visible depth is insufficient', () => {
  const e = engine();
  const r = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'market', qty: 50 }, book);
  assert.equal(r.ok, false);
  assert.match(r.error, /liquidity/);
  close(e.balance('USD'), 10_000);
});

test('insufficient balance is rejected for buys and sells', () => {
  const e = engine({ startingCash: 100 });
  assert.equal(e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'market', qty: 1 }, book).ok, false);
  assert.equal(e.placeOrder({ symbol: 'BTC', side: 'sell', type: 'market', qty: 1 }, book).ok, false);
  assert.equal(e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'limit', price: 90, qty: 5 }, book).ok, false);
});

test('resting limit reserves funds and fills as maker when the touch reaches it', () => {
  const e = engine();
  const r = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'limit', price: 95, qty: 10 }, book);
  assert.equal(r.ok, true);
  assert.equal(e.openOrders('BTC').length, 1);
  close(e.reserved('USD'), 950 * 1.002);
  close(e.available('USD'), 10_000 - 950 * 1.002);

  // A print below the limit fills partially (size-capped).
  e.onMarket('BTC', { ...book, trade: { price: 94.5, size: 4 } });
  close(e.openOrders('BTC')[0].filled, 4);
  // A print exactly at the limit does not fill (queue position unknown).
  e.onMarket('BTC', { ...book, trade: { price: 95, size: 100 } });
  close(e.openOrders('BTC')[0].filled, 4);
  // The ask dropping to the limit fills the remainder.
  e.onMarket('BTC', { bids: [[94, 1]], asks: [[95, 3]] });
  assert.equal(e.openOrders('BTC').length, 0);
  const done = e.state.history[0];
  assert.equal(done.status, 'filled');
  close(done.avgPrice, 95);
  assert.ok(e.state.fills.every((f) => f.liquidity === 'maker'));
  close(e.balance('USD'), 10_000 - 950 * 1.001);
});

test('marketable limit takes liquidity up to its price, remainder rests', () => {
  const e = engine();
  const r = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'limit', price: 102, qty: 5 }, book);
  assert.equal(r.ok, true);
  close(r.order.filled, 3);
  assert.equal(e.openOrders().length, 1);
  close(e.openOrders()[0].qty - e.openOrders()[0].filled, 2);
});

test('post-only rejects crossing orders; IOC cancels the remainder', () => {
  const e = engine();
  const p = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'limit', price: 101, qty: 1, postOnly: true }, book);
  assert.equal(p.ok, false);
  const i = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'limit', price: 101, qty: 3, ioc: true }, book);
  assert.equal(i.ok, true);
  close(i.order.filled, 1);
  assert.equal(e.openOrders().length, 0);
});

test('sell realises PnL against average cost', () => {
  const e = engine();
  e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'market', qty: 1 }, book); // @101
  const cost = 101 * 1.002;
  const up = { bids: [[120, 5]], asks: [[121, 5]], last: 120 };
  e.placeOrder({ symbol: 'BTC', side: 'sell', type: 'market', qty: 1 }, up);
  close(e.balance('BTC'), 0);
  close(e.state.realized.BTC, 120 * (1 - 0.002) - cost);
  close(e.summary().pnl, 120 * 0.998 - cost);
});

test('stops trigger on last price and execute as market orders', () => {
  const e = engine();
  const r = e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'stop', stopPrice: 105, qty: 1 }, book);
  assert.equal(r.ok, true);
  assert.equal(
    e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'stop', stopPrice: 99, qty: 1 }, book).ok,
    false,
    'buy stop below last is invalid',
  );
  e.onMarket('BTC', { ...book, last: 104 });
  assert.equal(e.openOrders().length, 1);
  e.onMarket('BTC', { bids: [[105, 1]], asks: [[106, 4]], last: 105.5 });
  assert.equal(e.openOrders().length, 0);
  close(e.balance('BTC'), 1);
  close(e.state.history[0].avgPrice, 106);
});

test('cancel releases reservations; state persists across instances', () => {
  const storage = createMemoryStorage();
  const a = engine({ storage });
  const r = a.placeOrder({ symbol: 'ETH', side: 'buy', type: 'limit', price: 50, qty: 2 }, book);
  close(a.available('USD'), 10_000 - 100 * 1.002);
  const b = engine({ storage });
  assert.equal(b.openOrders().length, 1);
  assert.equal(b.cancel(r.order.id), true);
  close(b.available('USD'), 10_000);
  assert.equal(b.state.history[0].status, 'canceled');
});

test('equity marks positions to the latest mid', () => {
  const e = engine();
  e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'market', qty: 1 }, book);
  e.onMarket('BTC', { bids: [[149, 1]], asks: [[151, 1]] });
  const pos = e.positions().find((p) => p.asset === 'BTC');
  close(pos.mark, 150);
  close(pos.unrealized, 150 - 101 * 1.002);
  close(e.equity(), e.balance('USD') + 150);
});

test('reset restores starting cash and clears orders', () => {
  const e = engine();
  e.placeOrder({ symbol: 'BTC', side: 'buy', type: 'limit', price: 90, qty: 1 }, book);
  e.reset(5000);
  close(e.balance('USD'), 5000);
  assert.equal(e.openOrders().length, 0);
});

test('price alerts fire once in the right direction', () => {
  const alerts = new PriceAlerts({ storage: createMemoryStorage() });
  const up = alerts.add('BTC', 110, 100);
  const down = alerts.add('BTC', 90, 100);
  assert.equal(up.direction, 'above');
  assert.equal(down.direction, 'below');
  assert.deepEqual(alerts.check('BTC', 105), []);
  assert.deepEqual(
    alerts.check('BTC', 111).map((a) => a.id),
    [up.id],
  );
  assert.deepEqual(alerts.check('BTC', 111), []);
  assert.equal(alerts.check('BTC', 89).length, 1);
  assert.equal(alerts.list.length, 0);
});
