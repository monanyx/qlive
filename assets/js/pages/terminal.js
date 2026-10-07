import {
  DEFAULTS,
  EXCHANGES,
  SYMBOLS,
  SYMBOL_IDS,
  TIMEFRAMES,
  decimalsOf,
  pairLabel,
  tickSize,
} from '../core/config.js';
import {
  fmtBps,
  fmtCompact,
  fmtMs,
  fmtPct,
  fmtPrice,
  fmtSize,
  fmtUsd,
  fmtUsdSigned,
  fmtUtcClock,
  roundTo,
} from '../core/format.js';
import { storage } from '../core/storage.js';
import { BinanceLiquidationFeed } from '../feeds/exchanges.js';
import { fetchHistory } from '../feeds/history.js';
import { FeedManager } from '../feeds/manager.js';
import { CandleSeries } from '../market/candles.js';
import { Market } from '../market/market.js';
import { LatencyMonitor } from '../metrics/latency.js';
import { PriceAlerts } from '../trading/alerts.js';
import { PaperEngine } from '../trading/paper-engine.js';
import { AccountView } from '../ui/account-view.js';
import { CandleChart } from '../ui/candle-chart.js';
import { DepthChart } from '../ui/depth-chart.js';
import { DiagnosticsView } from '../ui/diagnostics-view.js';
import { $, $$, choiceGroup, flash, h, setText, setTrend, tablist } from '../ui/dom.js';
import { LiquidityHeatmap } from '../ui/heatmap.js';
import { OrderBookView } from '../ui/orderbook-view.js';
import { OrderForm } from '../ui/order-form.js';
import { Scheduler } from '../ui/scheduler.js';
import { initSite } from '../ui/site.js';
import { chime } from '../ui/sound.js';
import { onThemeChange, toggleTheme } from '../ui/theme.js';
import { toast } from '../ui/toast.js';
import { TradeTape } from '../ui/trade-tape.js';

initSite();

/* ======================================================= state & settings */

const settings = { ...DEFAULTS, ...storage.get('settings', {}) };
const saveSettings = () => storage.set('settings', settings);

const params = new URLSearchParams(location.search);
const pick = (v, ok, fallback) => (ok(v) ? v : fallback);
let symbol = pick(params.get('symbol')?.toUpperCase(), (v) => v in SYMBOLS, storage.get('symbol', DEFAULTS.symbol));
if (!(symbol in SYMBOLS)) symbol = DEFAULTS.symbol;
let exchange = pick(params.get('exchange'), (v) => v in EXCHANGES, storage.get('exchange', DEFAULTS.exchange));
if (!(exchange in EXCHANGES)) exchange = DEFAULTS.exchange;
let timeframe = pick(
  Number(params.get('tf')),
  (v) => TIMEFRAMES.some((t) => t.sec === v),
  storage.get('timeframe', DEFAULTS.timeframe),
);
let chartMode = storage.get('chartMode', DEFAULTS.chartMode);
let grouping = storage.get(`grouping.${symbol}`, SYMBOLS[symbol].defaultGrouping);

const cfg = () => ({
  symbol,
  tick: tickSize(symbol),
  priceDecimals: SYMBOLS[symbol].priceDecimals,
  sizeDecimals: SYMBOLS[symbol].sizeDecimals,
  grouping,
  quote: 'USD',
});
const isBig = (t) => t.price * t.size >= settings.largeTradeUsd;

/* ============================================================ core objects */

const latency = new LatencyMonitor();
const scheduler = new Scheduler({ latency });
const market = new Market({ symbol, latency });
const feeds = new FeedManager({
  latency,
  autoFallback: settings.autoFallback,
  simDelay: settings.simLatency,
  simWarmup: 60,
  seedPrice: (s) => storage.get(`lastPrice.${s}`),
});
const engine = new PaperEngine({
  storage,
  startingCash: settings.startingCash,
  fees: { taker: settings.takerFee, maker: settings.makerFee },
});
const alerts = new PriceAlerts({ storage });
let candles = new CandleSeries(timeframe);
let liqFeed = null;

/* ================================================================== views */

const term = $('#term');
const form = new OrderForm({
  root: $('#order-form'),
  engine,
  market,
  config: cfg,
  onSubmitted: () => scheduler.mark('account'),
});

const bookView = new OrderBookView({
  root: $('#book'),
  market,
  config: cfg,
  openOrders: () => engine.openOrders(symbol),
  onPick: (price, side, cum, e) => {
    form.setPrice(price);
    if (e.shiftKey) form.setAmount(cum);
  },
  onResize: () => scheduler.mark('book'),
});

const chart = new CandleChart({ el: $('#candles'), legendEl: $('#chart-legend'), onAltClick: (p) => addAlert(p) });
const depth = new DepthChart({ canvas: $('#depth'), tip: $('#chart-tip'), market, config: cfg });
const heat = new LiquidityHeatmap({ canvas: $('#heatmap'), tip: $('#chart-tip'), market, config: cfg });

const tape = new TradeTape({ root: $('#tp-trades'), config: cfg, isBig });
const whales = new TradeTape({
  root: $('#tp-whales'),
  variant: 'whales',
  max: 100,
  config: cfg,
  isBig: () => true,
  emptyText: '',
});
const liqs = new TradeTape({
  root: $('#tp-liqs'),
  variant: 'liquidations',
  max: 100,
  config: cfg,
  isBig: (t) => t.price * t.size >= settings.largeTradeUsd,
  emptyText: 'Waiting for liquidations…',
});
const whaleText = () => `No prints ≥ $${fmtCompact(settings.largeTradeUsd)} yet.`;
whales.setEmptyText(whaleText());

const account = new AccountView({
  panels: {
    positions: $('#ap-positions'),
    orders: $('#ap-orders'),
    history: $('#ap-history'),
    fills: $('#ap-fills'),
    alerts: $('#ap-alerts'),
  },
  engine,
  alerts,
  counts: { orders: $('#c-orders'), alerts: $('#c-alerts') },
  actions: {
    cancel: (id) => engine.cancel(id),
    close: (asset) => closePosition(asset),
    removeAlert: (id) => alerts.remove(id),
  },
});

const diag = new DiagnosticsView({ root: $('#ap-diag'), latency, scheduler, market, feeds });

/* ====================================================== render scheduling */

const el = {
  pair: $('#s-pair'),
  name: $('#s-name'),
  last: $('#s-last'),
  change: $('#s-change'),
  high: $('#s-high'),
  low: $('#s-low'),
  vol: $('#s-vol'),
  mid: $('#s-mid'),
  spread: $('#s-spread'),
  flow: $('#s-flow'),
  flowBar: $('#s-flow-bar'),
  lag: $('#s-lag'),
  connDot: $('#conn-dot'),
  connText: $('#conn-text'),
  retry: $('#retry-live'),
  loading: $('#chart-loading'),
  equity: $('#a-equity'),
  pnl: $('#a-pnl'),
  realized: $('#a-realized'),
  fees: $('#a-fees'),
};

let lastFlash = 0;
let lastTitle = 0;
let chartCursor = 0; // time of the last bar pushed to the chart

function renderStats() {
  const { priceDecimals: dec } = cfg();
  const t = market.ticker;
  const last = market.last;
  const book = market.book;
  setText(el.last, fmtPrice(last, dec));
  const dir = last - market.prevPrice;
  if (dir) setTrend(el.last, dir);
  const chg = market.change24h;
  setText(el.change, fmtPct(chg));
  setTrend(el.change, chg);
  setText(el.high, fmtPrice(t.high24h, dec));
  setText(el.low, fmtPrice(t.low24h, dec));
  setText(el.vol, Number.isFinite(t.volume24h) ? `${fmtCompact(t.volume24h)} ${symbol}` : '—');
  el.vol.title = Number.isFinite(t.volume24h) && last > 0 ? `≈ ${fmtUsd(t.volume24h * last, 0)}` : '';
  setText(el.mid, fmtPrice(book.mid, dec + 1));
  setText(
    el.spread,
    Number.isFinite(book.spread) ? `${fmtPrice(book.spread, dec)} · ${fmtBps(book.spreadBps, 2)}` : '—',
  );
  const f = market.flow(60_000);
  setText(el.flow, f.count ? `${(f.ratio * 100).toFixed(0)}% buy` : '—');
  el.flowBar.style.width = `${(f.ratio * 100).toFixed(1)}%`;
  setText(el.lag, fmtMs(latency.stats('feed').p50));

  const now = performance.now();
  if (now - lastTitle > 1000 && Number.isFinite(last)) {
    lastTitle = now;
    document.title = `${fmtPrice(last, dec)} ${pairLabel(symbol, feeds.active ?? exchange)} · QuantumLive`;
  }
}

function renderChart() {
  const bars = candles.bars;
  if (!bars.length) return;
  for (let i = bars.length - 1; i >= 0 && bars[i].time >= chartCursor; i--) {
    if (i === 0 || bars[i - 1].time < chartCursor) {
      for (let j = i; j < bars.length; j++) chart.update(bars[j]);
      break;
    }
  }
  chartCursor = bars[bars.length - 1].time;
  if (!el.loading.hidden && bars.length) el.loading.hidden = true;
}

function renderAccountStrip() {
  const s = engine.summary();
  setText(el.equity, fmtUsd(s.equity));
  setText(el.pnl, `${fmtUsdSigned(s.pnl)} (${fmtPct(s.pnlPct)})`);
  setTrend(el.pnl, s.pnl);
  setText(el.realized, fmtUsdSigned(s.realized));
  setTrend(el.realized, s.realized);
  setText(el.fees, fmtUsd(s.feesPaid));
}

function renderOverlays() {
  chart.setOrders(engine.openOrders(symbol));
  chart.setAlerts(alerts.forSymbol(symbol));
  chart.setFills(engine.state.fills.filter((f) => f.symbol === symbol));
}

scheduler.add('book', () => bookView.render());
scheduler.add('stats', renderStats, { minInterval: 200 });
scheduler.add('chart', renderChart);
scheduler.add('tape', () => {
  tape.render();
  whales.render();
  liqs.render();
});
scheduler.add('form', () => form.render(), { minInterval: 250 });
scheduler.add(
  'account',
  () => {
    engine.setMark(symbol, market.book.mid);
    account.render();
    renderAccountStrip();
  },
  { minInterval: 500 },
);
scheduler.add('overlays', renderOverlays, { minInterval: 200 });
scheduler.add('depth', () => chartMode === 'depth' && depth.render(), { minInterval: 100 });
scheduler.add('heat', () => chartMode === 'heatmap' && heat.render(), { minInterval: 60 });
scheduler.add('diag', () => diag.render(), { minInterval: 500 });

/* ========================================================= market events */

let lastPriceSaved = 0;

let warming = false;
feeds.on('event', (ev) => {
  warming = !!ev.warmup;
  market.ingest(ev);
  // Simulator warm-up runs on simulated time: sample the heatmap on its clock.
  if (ev.warmup && ev.type === 'book') heat.sample(ev.ts);
});

market.on('book', () => {
  scheduler.mark('book');
  scheduler.mark('depth');
  if (engine.openOrders(symbol).length && !warming) {
    engine.onMarket(symbol, form.snapshot());
  }
});

market.on('trade', (t) => {
  const r = candles.addTrade(t.price, t.size, t.ts ?? t.recv);
  if (r) scheduler.mark('chart');
  tape.push(t);
  if (isBig(t)) whales.push(t);
  heat.addTrade(t);
  scheduler.mark('tape');
  scheduler.mark('stats');
  scheduler.mark('form');

  if (t.replay || t.warmup) return;
  if (engine.openOrders(symbol).length) engine.onMarket(symbol, { ...form.snapshot(), trade: t });
  alerts.check(symbol, t.price);

  const now = Date.now();
  if (feeds.active !== 'sim' && now - lastPriceSaved > 5000) {
    lastPriceSaved = now;
    storage.set(`lastPrice.${symbol}`, t.price);
  }
  if (settings.flashes && now - lastFlash > 400 && market.prevPrice !== t.price) {
    lastFlash = now;
    flash(el.last, t.price > market.prevPrice ? 'var(--up-soft)' : 'var(--down-soft)');
  }
});

market.on('ticker', () => scheduler.mark('stats'));
market.on('liquidation', (l) => {
  liqs.push(l);
  scheduler.mark('tape');
});
market.on('integrity', (reason) => {
  diag.addLog(`Integrity: ${reason} — resubscribing`);
  feeds.resync(reason);
});

setInterval(() => {
  heat.sample();
  if (heat.newCols) scheduler.mark('heat');
  scheduler.mark('account');
  scheduler.mark('diag');
}, 200);

/* ========================================================= feed status UI */

const STATE_TEXT = {
  connecting: 'Connecting…',
  open: 'Subscribing…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Connection error',
  closed: 'Disconnected',
};

feeds.on('status', (s) => {
  const venue = EXCHANGES[s.exchange];
  const sim = s.exchange === 'sim';
  let dot = 'dot';
  if (s.state === 'live') dot = sim ? 'dot dot--sim' : 'dot dot--live';
  else if (s.state === 'error') dot = 'dot dot--down';
  else if (s.state !== 'closed') dot = 'dot dot--warn';
  el.connDot.className = dot;
  $('#sb-dot').className = dot;

  let text = STATE_TEXT[s.state] ?? s.state;
  if (s.state === 'live') text = sim ? (s.fallback ? 'Simulator (fallback)' : 'Simulator') : `Live · ${venue.name}`;
  else if (s.state === 'connecting' && !sim) text = `Connecting to ${venue.name}…`;
  setText(el.connText, text);
  $('#conn').title = [venue.long, s.detail].filter(Boolean).join(' — ');
  el.retry.hidden = !s.fallback;

  if (s.state !== 'closed') diag.addLog(`${venue.name}: ${s.state}${s.detail ? ` (${s.detail})` : ''}`);
  if (s.state === 'live') syncLiquidationFeed();
});

feeds.on('fallback', ({ exchange: ex, reason }) => {
  toast({
    kind: 'warn',
    title: `${EXCHANGES[ex].name} unreachable — using the simulator`,
    message: `${reason}. The venue may be blocked on this network. Use “Retry live” to try again.`,
    timeout: 9000,
  });
  diag.addLog(`Fallback to simulator: ${reason}`);
  resetMarketState();
  loadHistory();
});

feeds.on('notice', (n) => {
  diag.addLog(n.message);
  toast({ kind: 'warn', title: 'Feed notice', message: n.message });
});

el.retry.addEventListener('click', () => switchMarket(symbol, exchange));

/** Liquidations: Binance USDⓈ-M futures stream while on a live venue; the simulator emits its own. */
function syncLiquidationFeed() {
  const want = feeds.active !== 'sim';
  if (liqFeed && (!want || liqFeed.symbol !== symbol)) {
    liqFeed.stop();
    liqFeed = null;
  }
  if (!want || liqFeed) return;
  let opened = false;
  liqs.setEmptyText('Connecting to Binance Futures liquidation stream…');
  liqFeed = new BinanceLiquidationFeed({
    symbol,
    onEvent: (ev) => market.ingest(ev),
    onStatus: (s) => {
      if (s.state === 'open') {
        opened = true;
        liqs.setEmptyText('Listening for Binance USDⓈ-M liquidations…');
      } else if (!opened && s.state === 'reconnecting' && s.attempt >= 2) {
        liqs.setEmptyText('Liquidation stream unavailable on this network (Binance Futures).');
      }
    },
  });
  liqFeed.start();
}

/* ======================================================== market switching */

function resetMarketState() {
  market.reset(symbol);
  candles = new CandleSeries(timeframe);
  chartCursor = 0;
  chart.setBars([]);
  tape.clear('Waiting for trades…');
  whales.clear(whaleText());
  liqs.clear('Waiting for liquidations…');
  heat.reset();
  el.loading.hidden = false;
  scheduler.markAll();
}

let historyGen = 0;
async function loadHistory() {
  const gen = ++historyGen;
  const { priceDecimals } = cfg();
  chart.setFormat(priceDecimals, timeframe);
  el.loading.hidden = false;
  el.loading.firstElementChild.lastChild.textContent = 'Loading history…';
  let bars = feeds.simHistory(timeframe, 600);
  if (!bars) bars = await fetchHistory(feeds.exchange, symbol, timeframe, { limit: 600 });
  if (gen !== historyGen) return;
  if (bars.length) candles.mergeHistory(bars);
  chart.setBars(candles.bars);
  chartCursor = candles.last?.time ?? 0;
  renderOverlays();
  if (candles.bars.length) el.loading.hidden = true;
  else el.loading.firstElementChild.lastChild.textContent = 'Waiting for the first trade…';
}

function updateLabels() {
  const c = SYMBOLS[symbol];
  const venue = feeds.active ?? exchange;
  setText(el.pair, pairLabel(symbol, venue === 'sim' ? 'coinbase' : venue));
  setText(el.name, `${c.name} · ${EXCHANGES[exchange].name}`);
  $('#symbol').value = symbol;
  venueGroup.set(exchange, false);
  $('#venue-select').value = exchange;
  for (const u of $$('[data-unit="base"]')) setText(u, symbol);

  const sel = $('#book-group');
  sel.replaceChildren(...c.groupings.map((g) => h('option', { value: g }, fmtPrice(g, decimalsOf(g)))));
  if (!c.groupings.includes(grouping)) grouping = c.defaultGrouping;
  sel.value = String(grouping);
}

function persist() {
  storage.set('symbol', symbol);
  storage.set('exchange', exchange);
  storage.set('timeframe', timeframe);
  const url = new URL(location.href);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('exchange', exchange);
  url.searchParams.set('tf', timeframe);
  history.replaceState(null, '', url);
}

function switchMarket(sym, ex) {
  const symChanged = sym !== symbol;
  symbol = sym;
  exchange = ex;
  if (symChanged) {
    grouping = storage.get(`grouping.${symbol}`, SYMBOLS[symbol].defaultGrouping);
    form.reset();
  }
  chart.clearOverlays();
  resetMarketState();
  // The liquidation stream (re)starts once the new feed reports 'live'.
  liqFeed?.stop();
  liqFeed = null;
  feeds.start(exchange, symbol);
  updateLabels();
  persist();
  loadHistory();
  scheduler.markAll();
}

function setTimeframe(sec) {
  timeframe = sec;
  tfGroup.set(String(sec), false);
  candles = new CandleSeries(sec);
  for (const t of market.trades) if (!t.replay) candles.addTrade(t.price, t.size, t.ts ?? t.recv);
  chartCursor = 0;
  chart.setBars([]);
  persist();
  loadHistory();
}

function setChartMode(mode) {
  chartMode = mode;
  storage.set('chartMode', mode);
  chartTabs.select(mode);
  $('#candles').hidden = mode !== 'candles';
  $('#depth').hidden = mode !== 'depth';
  $('#heatmap').hidden = mode !== 'heatmap';
  $('#chart-legend').hidden = mode !== 'candles';
  $('#chart-hint').hidden = mode !== 'candles';
  $('#tf').hidden = mode !== 'candles';
  $('#depth-zoom').hidden = mode !== 'depth';
  $('#chart-tip').hidden = true;
  if (mode !== 'candles') el.loading.hidden = true;
  else if (!candles.bars.length) el.loading.hidden = false;
  heat.needsFull = true;
  scheduler.markAll();
}

/* ============================================================== controls */

$('#symbol').replaceChildren(
  ...SYMBOL_IDS.map((id) => h('option', { value: id, title: SYMBOLS[id].name }, `${id}-USD`)),
);
$('#symbol').addEventListener('change', (e) => switchMarket(e.target.value, exchange));

const venueGroup = choiceGroup($('#venue'), {
  attr: 'aria-checked',
  onChange: (v) => v !== exchange && switchMarket(symbol, v),
});
$('#venue-select').addEventListener('change', (e) => switchMarket(symbol, e.target.value));

$('#tf').replaceChildren(
  ...TIMEFRAMES.map((t) =>
    h('button', { type: 'button', dataset: { value: t.sec }, 'aria-pressed': 'false' }, t.label),
  ),
);
const tfGroup = choiceGroup($('#tf'), { onChange: (v) => setTimeframe(Number(v)) });
tfGroup.set(String(timeframe), false);

const chartTabs = tablist($('#chart-tabs'), { onChange: (v) => v !== chartMode && setChartMode(v) });
$('#depth-zoom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zoom]');
  if (b) depth.zoom(b.dataset.zoom === 'in' ? 1 / 1.4 : 1.4);
});

const bookMode = choiceGroup($('#book-mode'), {
  onChange: (m) => {
    bookView.setMode(m);
    scheduler.mark('book');
  },
});
bookMode.set('both', false);

$('#book-group').addEventListener('change', (e) => {
  grouping = Number(e.target.value);
  storage.set(`grouping.${symbol}`, grouping);
  scheduler.mark('book');
});

tablist($('#activity-tabs'));
tablist($('#account-tabs'), {
  onChange: (id) => {
    $('#cancel-all').hidden = id !== 't-orders';
    scheduler.mark('diag');
  },
});

const mobileTabs = tablist($('#mobile-tabs'), {
  onChange: (v) => {
    term.dataset.view = v;
    scheduler.markAll();
  },
});

$('#cancel-all').addEventListener('click', cancelAll);

function cancelAll() {
  const n = engine.cancelAll(symbol);
  toast({ title: n ? `Canceled ${n} order${n > 1 ? 's' : ''}` : 'No open orders', message: `${symbol}-USD` });
}

function addAlert(price) {
  const { tick, priceDecimals } = cfg();
  const a = alerts.add(symbol, roundTo(price, tick), market.last);
  if (!a) return;
  toast({
    kind: 'info',
    title: 'Price alert set',
    message: `${symbol}-USD ${a.direction === 'above' ? 'rises to' : 'falls to'} ${fmtPrice(a.price, priceDecimals)}`,
  });
}

function promptAlert() {
  const { priceDecimals } = cfg();
  const last = market.last;
  const answer = prompt(
    `Alert when ${symbol}-USD reaches price:`,
    Number.isFinite(last) ? last.toFixed(priceDecimals) : '',
  );
  const price = Number(answer?.replace(/[,\s$]/g, ''));
  if (!(price > 0)) return;
  if (price === last) {
    toast({ kind: 'warn', title: 'Alert not set', message: 'Choose a price above or below the last trade.' });
    return;
  }
  addAlert(price);
}

function closePosition(asset) {
  if (asset !== symbol) {
    switchMarket(asset, exchange);
    toast({ title: `Switched to ${asset}-USD`, message: 'Press Close again once the order book has loaded.' });
    return;
  }
  form.setSide('sell');
  form.setType('market');
  form.setAmount(engine.available(asset));
  form.submit();
}

/* ================================================== engine & alert events */

engine.on('order', (o, kind) => {
  const d = SYMBOLS[o.symbol]?.priceDecimals ?? 2;
  const qty = `${fmtSize(o.qty, SYMBOLS[o.symbol]?.sizeDecimals ?? 4)} ${o.symbol}`;
  const verb = o.side === 'buy' ? 'Bought' : 'Sold';
  if (kind === 'placed') {
    const at = o.type === 'stop' ? `stop ${fmtPrice(o.stopPrice, d)}` : `@ ${fmtPrice(o.price, d)}`;
    toast({ title: `${o.type === 'stop' ? 'Stop' : 'Limit'} ${o.side} placed`, message: `${qty} ${at}` });
  } else if (kind === 'filled') {
    toast({
      kind: 'success',
      title: `${verb} ${fmtSize(o.filled, SYMBOLS[o.symbol]?.sizeDecimals ?? 4)} ${o.symbol}`,
      message: `Avg ${fmtPrice(o.avgPrice, d)} · fee ${fmtUsd(o.fees)}`,
    });
    if (settings.sounds) chime(o.side === 'buy' ? 'fill' : 'sell');
  } else if (kind === 'canceled') {
    toast({ title: 'Order canceled', message: o.filled > 0 ? `${qty} (partially filled)` : qty, timeout: 2500 });
  } else if (kind === 'rejected') {
    toast({ kind: 'error', title: 'Order rejected', message: o.reason ?? '' });
  } else if (kind === 'triggered') {
    toast({ kind: 'warn', title: 'Stop triggered', message: `${o.side.toUpperCase()} ${qty} at market` });
  }
});

engine.on('fill', (f, o) => {
  if (f.liquidity === 'maker' && o.filled < o.qty - 1e-10) {
    toast({
      kind: 'success',
      title: 'Partial fill',
      message: `${fmtSize(f.qty, SYMBOLS[f.symbol]?.sizeDecimals ?? 4)} ${f.symbol} @ ${fmtPrice(f.price, SYMBOLS[f.symbol]?.priceDecimals ?? 2)}`,
    });
  }
});

engine.on('change', () => {
  scheduler.mark('account');
  scheduler.mark('overlays');
  scheduler.mark('book');
  scheduler.mark('form');
});
engine.on('reset', () =>
  toast({ kind: 'success', title: 'Paper account reset', message: `Balance ${fmtUsd(engine.state.startingCash)}` }),
);

alerts.on('fire', (a, price) => {
  toast({
    kind: 'warn',
    title: `${a.symbol}-USD ${a.direction === 'above' ? '≥' : '≤'} ${fmtPrice(a.price, SYMBOLS[a.symbol].priceDecimals)}`,
    message: `Last trade ${fmtPrice(price, SYMBOLS[a.symbol].priceDecimals)}`,
    timeout: 10_000,
  });
  if (settings.sounds) chime('alert');
});
alerts.on('change', () => {
  scheduler.mark('overlays');
  scheduler.mark('account');
});

/* ============================================================== settings */

const dlgSettings = $('#dlg-settings');
const dlgKeys = $('#dlg-keys');

function openSettings() {
  $('#set-fallback').checked = settings.autoFallback;
  $('#set-simdelay').checked = settings.simLatency;
  $('#set-whale').value = String(settings.largeTradeUsd);
  $('#set-fees').value = `${settings.takerFee}/${settings.makerFee}`;
  $('#set-sounds').checked = settings.sounds;
  $('#set-flashes').checked = settings.flashes;
  $('#set-cash').value = String(engine.state.startingCash);
  dlgSettings.showModal();
}

$('#btn-settings').addEventListener('click', openSettings);
$('#btn-shortcuts').addEventListener('click', () => dlgKeys.showModal());

dlgSettings.addEventListener('change', (e) => {
  const t = e.target;
  switch (t.id) {
    case 'set-fallback':
      settings.autoFallback = feeds.autoFallback = t.checked;
      break;
    case 'set-simdelay':
      settings.simLatency = feeds.simDelay = t.checked;
      if (feeds.active === 'sim')
        toast({ title: 'Applies on reconnect', message: 'Switch market or venue to restart the simulator.' });
      break;
    case 'set-whale':
      settings.largeTradeUsd = Number(t.value);
      whales.setEmptyText(whaleText());
      break;
    case 'set-fees': {
      const [taker, maker] = t.value.split('/').map(Number);
      settings.takerFee = taker;
      settings.makerFee = maker;
      engine.setFees({ taker, maker });
      scheduler.mark('form');
      break;
    }
    case 'set-sounds':
      settings.sounds = t.checked;
      if (t.checked) chime('fill');
      break;
    case 'set-flashes':
      settings.flashes = t.checked;
      break;
    default:
      return;
  }
  saveSettings();
});

$('#set-reset').addEventListener('click', () => {
  const cash = Number($('#set-cash').value);
  if (!confirm(`Reset the paper account to ${fmtUsd(cash, 0)}? Open orders, history and positions will be cleared.`))
    return;
  settings.startingCash = cash;
  saveSettings();
  engine.reset(cash);
});

/* ============================================================== keyboard */

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  const key = e.key;
  const idx = SYMBOL_IDS.indexOf(symbol);
  const groupings = SYMBOLS[symbol].groupings;
  const gi = groupings.indexOf(grouping);
  const actions = {
    b: () => form.setSide('buy'),
    s: () => form.setSide('sell'),
    l: () => form.setType('limit'),
    m: () => form.setType('market'),
    o: () => form.setType('stop'),
    '/': () => form.focusAmount(),
    c: () => setChartMode('candles'),
    d: () => setChartMode('depth'),
    h: () => setChartMode('heatmap'),
    g: () => setGrouping(groupings[Math.min(groupings.length - 1, gi + 1)]),
    G: () => setGrouping(groupings[Math.max(0, gi - 1)]),
    '[': () => switchMarket(SYMBOL_IDS[(idx - 1 + SYMBOL_IDS.length) % SYMBOL_IDS.length], exchange),
    ']': () => switchMarket(SYMBOL_IDS[(idx + 1) % SYMBOL_IDS.length], exchange),
    a: promptAlert,
    x: cancelAll,
    t: toggleTheme,
    '?': () => dlgKeys.showModal(),
  };
  const tf = TIMEFRAMES[Number(key) - 1];
  if (tf && chartMode === 'candles') {
    e.preventDefault();
    setTimeframe(tf.sec);
    return;
  }
  const fn = actions[key] ?? actions[key.toLowerCase()];
  if (fn && !(key === 'G' && !e.shiftKey)) {
    e.preventDefault();
    fn();
  }
});

function setGrouping(g) {
  grouping = g;
  storage.set(`grouping.${symbol}`, g);
  $('#book-group').value = String(g);
  scheduler.mark('book');
}

/* ================================================================== theme */

onThemeChange(() => {
  chart.applyTheme();
  depth.readColors();
  heat.readColors();
  renderOverlays();
  scheduler.markAll();
});

/* ============================================================= status bar */

setInterval(() => {
  const venue = feeds.active ?? exchange;
  setText(
    $('#sb-source'),
    `${EXCHANGES[venue].long}${feeds.fallback ? ' (fallback)' : ''} · ${pairLabel(symbol, venue === 'sim' ? 'coinbase' : venue)}`,
  );
  setText($('#sb-msgs'), latency.messages.rate().toFixed(0));
  setText($('#sb-lag'), fmtMs(latency.stats('feed').p50));
  setText($('#sb-render'), fmtMs(latency.stats('render').p95));
  setText($('#sb-fps'), performance.now() - scheduler.lastFrame < 1500 ? scheduler.fps.toFixed(0) : '0');
  setText($('#sb-clock'), fmtUtcClock());
}, 1000);

// Persist the paper account periodically (marks drift between fills).
setInterval(() => engine.save(), 15_000);
addEventListener('pagehide', () => engine.save());

/* ================================================================== start */

updateLabels();
setChartMode(chartMode);
form.reset();
switchMarket(symbol, exchange);
mobileTabs.select(term.dataset.view);

// Expose a tiny debug handle for the console (and the e2e smoke test).
window.qlive = {
  market,
  engine,
  feeds,
  latency,
  alerts,
  switchMarket,
  get symbol() {
    return symbol;
  },
};
