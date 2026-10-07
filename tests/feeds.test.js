import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoinbaseFeed, LIVE_FEEDS } from '../assets/js/feeds/exchanges.js';
import { FeedManager } from '../assets/js/feeds/manager.js';
import { SimFeed } from '../assets/js/feeds/sim-feed.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Coinbase shows top of book from the ticker until the L2 snapshot arrives', () => {
  const feed = new CoinbaseFeed({ symbol: 'BTC' });
  feed.subscriptions(); // resets per-connection state
  const ticker = {
    type: 'ticker',
    price: '100.5',
    best_bid: '100',
    best_bid_size: '2',
    best_ask: '101',
    best_ask_size: '3',
  };
  const tob = feed.normalize(ticker, 1).find((e) => e.type === 'book');
  assert.deepEqual(tob.bids, [[100, 2]]);
  assert.deepEqual(tob.asks, [[101, 3]]);
  assert.equal(tob.topOfBook, true);

  feed.normalize({ type: 'snapshot', bids: [['99', '1']], asks: [['102', '1']] }, 2);
  assert.equal(
    feed.normalize(ticker, 3).some((e) => e.type === 'book'),
    false,
    'no synthetic book once L2 is live',
  );
});

test('SimFeed warm-up replays flagged history, then streams live', async () => {
  const events = [];
  const states = [];
  const feed = new SimFeed({
    symbol: 'ETH',
    seed: 7,
    networkDelay: false,
    warmupSec: 5,
    onEvent: (e) => events.push(e),
    onStatus: (s) => states.push(s.state),
  });
  feed.start();
  await wait(600);
  feed.stop();
  const warm = events.filter((e) => e.warmup);
  const live = events.slice(events.indexOf(warm.at(-1)) + 1).filter((e) => e.type !== 'ticker');
  assert.equal(events[0].action, 'snapshot');
  assert.ok(warm.length > 20, `warm-up events: ${warm.length}`);
  assert.ok(live.length > 0, 'live events after warm-up');
  assert.ok(warm.at(-1).ts <= live[0].ts);
  assert.deepEqual(states.slice(0, 3), ['connecting', 'open', 'live']);
  assert.ok(feed.history(60, 50).length === 50);
});

test('FeedManager falls back to the simulator and has its history ready', async () => {
  class SilentFeed {
    start() {}
    stop() {}
  }
  const original = LIVE_FEEDS.coinbase;
  LIVE_FEEDS.coinbase = SilentFeed;
  try {
    const m = new FeedManager({ liveTimeoutMs: 80, simWarmup: 0, simDelay: false });
    let historyAtFallback = null;
    m.on('fallback', () => {
      historyAtFallback = m.simHistory(60, 10);
    });
    const got = [];
    m.on('event', (e) => got.push(e));
    m.start('coinbase', 'BTC');
    assert.equal(m.active, 'coinbase');
    await wait(450);
    assert.equal(m.active, 'sim');
    assert.equal(m.fallback, true);
    assert.equal(historyAtFallback?.length, 10, 'sim history available inside the fallback event');
    assert.ok(got.some((e) => e.type === 'book'));
    m.stop();
  } finally {
    LIVE_FEEDS.coinbase = original;
  }
});
