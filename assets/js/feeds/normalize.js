/**
 * Pure message normalisers: exchange wire format → QuantumLive events
 * (see market/market.js for the event shapes). No I/O, fully unit-tested.
 *
 * Side conventions: trade `side` is always the TAKER (aggressor) side.
 */

const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const time = (iso, fallback) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};
const levels = (arr) => (arr ?? []).map(([p, s]) => [num(p), num(s)]);

/* ------------------------------------------------------------------ Coinbase
 * wss://ws-feed.exchange.coinbase.com — channels: level2_batch, matches,
 * ticker, heartbeat. `match.side` is the MAKER side, so the taker is the
 * opposite side.
 */
export function normalizeCoinbase(msg, recv = Date.now()) {
  switch (msg.type) {
    case 'snapshot':
      return [
        {
          type: 'book',
          action: 'snapshot',
          bids: levels(msg.bids),
          asks: levels(msg.asks),
          ts: time(msg.time, recv),
          recv,
        },
      ];
    case 'l2update':
      return [
        {
          type: 'book',
          action: 'delta',
          changes: msg.changes.map(([side, p, s]) => [side === 'buy' ? 'bid' : 'ask', num(p), num(s)]),
          ts: time(msg.time, recv),
          recv,
        },
      ];
    case 'match':
    case 'last_match':
      return [
        {
          type: 'trade',
          id: msg.trade_id,
          price: num(msg.price),
          size: num(msg.size),
          side: msg.side === 'buy' ? 'sell' : 'buy',
          ts: time(msg.time, recv),
          recv,
          replay: msg.type === 'last_match',
        },
      ];
    case 'ticker':
      return [
        {
          type: 'ticker',
          product: msg.product_id,
          last: num(msg.price),
          open24h: num(msg.open_24h),
          high24h: num(msg.high_24h),
          low24h: num(msg.low_24h),
          volume24h: num(msg.volume_24h),
          ts: time(msg.time, recv),
          recv,
        },
      ];
    case 'error':
      return [{ type: 'error', message: [msg.message, msg.reason].filter(Boolean).join(': ') }];
    default:
      return []; // subscriptions, heartbeat, …
  }
}

/* ------------------------------------------------------------------ Binance
 * Combined stream: wss://stream.binance.com:9443/stream?streams=…
 * Payload envelope: { stream, data }. Uses partial-depth snapshots
 * (`@depth20@100ms`), aggregated trades and the 24 h rolling ticker.
 * aggTrade `m` = "buyer is the maker" → taker sold.
 */
export function normalizeBinance(msg, recv = Date.now()) {
  const data = msg.data ?? msg;
  const stream = msg.stream ?? '';
  if (stream.includes('@depth') || (data.lastUpdateId !== undefined && data.bids)) {
    return [{ type: 'book', action: 'snapshot', bids: levels(data.bids), asks: levels(data.asks), ts: recv, recv }];
  }
  switch (data.e) {
    case 'aggTrade':
    case 'trade':
      return [
        {
          type: 'trade',
          id: data.a ?? data.t,
          price: num(data.p),
          size: num(data.q),
          side: data.m ? 'sell' : 'buy',
          ts: data.E ?? data.T,
          recv,
        },
      ];
    case '24hrTicker':
      return [
        {
          type: 'ticker',
          product: data.s,
          last: num(data.c),
          open24h: num(data.o),
          high24h: num(data.h),
          low24h: num(data.l),
          volume24h: num(data.v),
          changePct: num(data.P),
          ts: data.E,
          recv,
        },
      ];
    case 'forceOrder': {
      const o = data.o;
      return [
        {
          type: 'liquidation',
          // A forced SELL closes a long position; a forced BUY closes a short.
          side: o.S === 'SELL' ? 'long' : 'short',
          price: num(o.ap) || num(o.p),
          size: num(o.z) || num(o.q),
          ts: o.T ?? data.E,
          recv,
        },
      ];
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ Kraken
 * WebSocket API v2: wss://ws.kraken.com/v2 — channels book, trade, ticker.
 * Prices/quantities arrive as JSON numbers. The book must be truncated to
 * the subscribed depth after each update.
 */
export function normalizeKraken(msg, recv = Date.now(), depth = 25) {
  if (msg.method === 'subscribe' && msg.success === false) {
    return [{ type: 'error', message: msg.error ?? 'Subscription failed' }];
  }
  const out = [];
  switch (msg.channel) {
    case 'book':
      for (const d of msg.data ?? []) {
        const ts = time(d.timestamp, recv);
        if (msg.type === 'snapshot') {
          out.push({
            type: 'book',
            action: 'snapshot',
            bids: d.bids.map((l) => [l.price, l.qty]),
            asks: d.asks.map((l) => [l.price, l.qty]),
            depth,
            ts,
            recv,
          });
        } else {
          out.push({
            type: 'book',
            action: 'delta',
            changes: [...d.bids.map((l) => ['bid', l.price, l.qty]), ...d.asks.map((l) => ['ask', l.price, l.qty])],
            depth,
            ts,
            recv,
          });
        }
      }
      return out;
    case 'trade':
      for (const t of msg.data ?? []) {
        out.push({
          type: 'trade',
          id: t.trade_id,
          price: t.price,
          size: t.qty,
          side: t.side,
          ts: time(t.timestamp, recv),
          recv,
          replay: msg.type === 'snapshot',
        });
      }
      return out;
    case 'ticker':
      for (const d of msg.data ?? []) {
        out.push({
          type: 'ticker',
          product: d.symbol,
          last: d.last,
          open24h: Number.isFinite(d.change) ? d.last - d.change : NaN,
          high24h: d.high,
          low24h: d.low,
          volume24h: d.volume,
          changePct: d.change_pct,
          ts: recv,
          recv,
        });
      }
      return out;
    default:
      return []; // heartbeat, status, subscribe acks
  }
}
