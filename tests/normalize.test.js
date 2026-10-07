import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBinance, normalizeCoinbase, normalizeKraken } from '../assets/js/feeds/normalize.js';
import { parseHistory, historyUrl } from '../assets/js/feeds/history.js';

// Fixtures follow the public API documentation of each venue.

test('Coinbase snapshot, l2update, match (maker side inverted), ticker', () => {
  const recv = 1_700_000_000_500;
  const [snap] = normalizeCoinbase(
    { type: 'snapshot', product_id: 'BTC-USD', bids: [['10101.10', '0.45054140']], asks: [['10102.55', '0.57753524']] },
    recv,
  );
  assert.deepEqual(snap.bids, [[10101.1, 0.4505414]]);
  assert.equal(snap.action, 'snapshot');

  const [delta] = normalizeCoinbase({
    type: 'l2update',
    product_id: 'BTC-USD',
    time: '2019-08-14T20:42:27.265Z',
    changes: [
      ['buy', '10101.80000000', '0.162567'],
      ['sell', '10102.55', '0'],
    ],
  });
  assert.deepEqual(delta.changes, [
    ['bid', 10101.8, 0.162567],
    ['ask', 10102.55, 0],
  ]);
  assert.equal(delta.ts, Date.parse('2019-08-14T20:42:27.265Z'));

  const [trade] = normalizeCoinbase({
    type: 'match',
    trade_id: 10,
    side: 'sell',
    size: '5.23512',
    price: '400.23',
    product_id: 'BTC-USD',
    time: '2014-11-07T08:19:27.028459Z',
  });
  assert.equal(trade.side, 'buy', 'maker sell ⇒ taker buy');
  assert.equal(trade.price, 400.23);
  assert.equal(trade.size, 5.23512);

  const [last] = normalizeCoinbase({
    type: 'last_match',
    side: 'buy',
    price: '1',
    size: '1',
    time: '2020-01-01T00:00:00Z',
  });
  assert.equal(last.replay, true);
  assert.equal(last.side, 'sell');

  const [tk] = normalizeCoinbase({
    type: 'ticker',
    product_id: 'ETH-USD',
    price: '333.99',
    open_24h: '320.00',
    volume_24h: '5.88',
    low_24h: '310.10',
    high_24h: '340.00',
    time: '2015-03-19T19:19:12.893Z',
  });
  assert.equal(tk.product, 'ETH-USD');
  assert.equal(tk.open24h, 320);
  assert.equal(tk.high24h, 340);

  const [err] = normalizeCoinbase({ type: 'error', message: 'Failed to subscribe', reason: 'auth required' });
  assert.equal(err.type, 'error');
  assert.match(err.message, /auth required/);

  assert.deepEqual(normalizeCoinbase({ type: 'heartbeat' }), []);
  assert.deepEqual(normalizeCoinbase({ type: 'subscriptions', channels: [] }), []);
});

test('Binance combined stream: partial depth, aggTrade, 24hrTicker, forceOrder', () => {
  const [book] = normalizeBinance(
    {
      stream: 'btcusdt@depth20@100ms',
      data: { lastUpdateId: 160, bids: [['0.0024', '10']], asks: [['0.0026', '100']] },
    },
    5,
  );
  assert.equal(book.action, 'snapshot');
  assert.deepEqual(book.asks, [[0.0026, 100]]);

  const [t] = normalizeBinance({
    stream: 'btcusdt@aggTrade',
    data: { e: 'aggTrade', E: 123456789, s: 'BTCUSDT', a: 12345, p: '0.001', q: '100', T: 123456785, m: true },
  });
  assert.equal(t.side, 'sell', 'buyer is maker ⇒ taker sold');
  assert.equal(t.ts, 123456789);

  const [tk] = normalizeBinance({
    stream: 'btcusdt@ticker',
    data: { e: '24hrTicker', E: 1, s: 'BTCUSDT', P: '2.5', c: '102.5', o: '100', h: '103', l: '99', v: '1234.5' },
  });
  assert.equal(tk.last, 102.5);
  assert.equal(tk.changePct, 2.5);
  assert.equal(tk.volume24h, 1234.5);

  const [liq] = normalizeBinance({
    e: 'forceOrder',
    E: 1568014460893,
    o: {
      s: 'BTCUSDT',
      S: 'SELL',
      o: 'LIMIT',
      q: '0.014',
      p: '9910',
      ap: '9910',
      X: 'FILLED',
      z: '0.014',
      T: 1568014460893,
    },
  });
  assert.equal(liq.type, 'liquidation');
  assert.equal(liq.side, 'long');
  assert.equal(liq.price, 9910);
});

test('Kraken v2: book snapshot/update with depth, trades, ticker, errors', () => {
  const [snap] = normalizeKraken({
    channel: 'book',
    type: 'snapshot',
    data: [
      {
        symbol: 'BTC/USD',
        bids: [{ price: 45283.5, qty: 0.1 }],
        asks: [{ price: 45285.2, qty: 0.001 }],
        checksum: 1,
      },
    ],
  });
  assert.equal(snap.action, 'snapshot');
  assert.equal(snap.depth, 25);
  assert.deepEqual(snap.bids, [[45283.5, 0.1]]);

  const [upd] = normalizeKraken({
    channel: 'book',
    type: 'update',
    data: [
      {
        symbol: 'BTC/USD',
        bids: [{ price: 45283.5, qty: 0 }],
        asks: [{ price: 45286, qty: 2 }],
        checksum: 2,
        timestamp: '2023-10-06T17:35:55.440295Z',
      },
    ],
  });
  assert.deepEqual(upd.changes, [
    ['bid', 45283.5, 0],
    ['ask', 45286, 2],
  ]);
  assert.equal(upd.ts, Date.parse('2023-10-06T17:35:55.440Z'));

  const trades = normalizeKraken({
    channel: 'trade',
    type: 'update',
    data: [
      {
        symbol: 'BTC/USD',
        side: 'sell',
        price: 45000.1,
        qty: 0.5,
        ord_type: 'market',
        trade_id: 1,
        timestamp: '2023-09-25T07:49:37.708706Z',
      },
      {
        symbol: 'BTC/USD',
        side: 'buy',
        price: 45000.2,
        qty: 0.1,
        ord_type: 'limit',
        trade_id: 2,
        timestamp: '2023-09-25T07:49:37.708706Z',
      },
    ],
  });
  assert.equal(trades.length, 2);
  assert.equal(trades[0].side, 'sell');
  assert.equal(trades[0].replay, false);

  const [tk] = normalizeKraken({
    channel: 'ticker',
    type: 'snapshot',
    data: [{ symbol: 'ETH/USD', last: 110, change: 10, change_pct: 10, high: 112, low: 99, volume: 500 }],
  });
  assert.equal(tk.open24h, 100);
  assert.equal(tk.changePct, 10);

  const [err] = normalizeKraken({ method: 'subscribe', success: false, error: 'Currency pair not supported' });
  assert.equal(err.type, 'error');
  assert.deepEqual(normalizeKraken({ channel: 'heartbeat' }), []);
});

test('history parsers normalise each venue to ascending bars', () => {
  const cb = parseHistory('coinbase', [
    [120, 9, 12, 10, 11, 5],
    [60, 8, 11, 9, 10, 4],
  ]);
  assert.deepEqual(cb[0], { time: 60, open: 9, high: 11, low: 8, close: 10, volume: 4 });
  assert.equal(cb[1].time, 120);

  const bn = parseHistory('binance', [[60_000, '1', '2', '0.5', '1.5', '10', 119_999, '15', 3, '5', '7', '0']]);
  assert.deepEqual(bn[0], { time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

  const kr = parseHistory('kraken', {
    error: [],
    result: { XXBTZUSD: [[60, '1', '2', '0.5', '1.5', '1.2', '10', 3]], last: 60 },
  });
  assert.deepEqual(kr[0], { time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

  assert.equal(historyUrl('coinbase', 'BTC', 1), null, 'Coinbase has no 1s candles');
  assert.match(historyUrl('binance', 'ETH', 1), /interval=1s/);
  assert.match(historyUrl('kraken', 'DOGE', 3600), /pair=XDGUSD&interval=60/);
});
