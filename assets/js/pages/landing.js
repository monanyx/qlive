import { SYMBOLS, SYMBOL_IDS, tickSize } from '../core/config.js';
import { fmtPct, fmtPrice, fmtSize } from '../core/format.js';
import { storage } from '../core/storage.js';
import { MultiTicker } from '../feeds/multi-ticker.js';
import { Market } from '../market/market.js';
import { MarketSim } from '../sim/market-sim.js';
import { DepthChart } from '../ui/depth-chart.js';
import { $, h, setText, setTrend } from '../ui/dom.js';
import { LiquidityHeatmap } from '../ui/heatmap.js';
import { initSite } from '../ui/site.js';
import { onThemeChange } from '../ui/theme.js';

initSite();

/* ------------------------------------------------ hero: simulated market */

const symbol = 'BTC';
const cfg = () => ({
  symbol,
  tick: tickSize(symbol),
  priceDecimals: 2,
  sizeDecimals: SYMBOLS[symbol].sizeDecimals,
  grouping: 1,
});
const market = new Market({ symbol });
const heat = new LiquidityHeatmap({
  canvas: $('#demo-heat'),
  market,
  config: cfg,
  columnMs: 120,
  colW: 3,
  rangePct: 0.0012,
});
const depth = new DepthChart({ canvas: $('#demo-depth'), tip: $('#depth-tip'), market, config: cfg });
depth.range = 0.006;

// Drive the simulator directly so the heatmap can be back-filled with ~40 s
// of simulated history before the first paint, then run in real time.
const c = SYMBOLS[symbol];
const sim = new MarketSim({
  price: storage.get(`lastPrice.${symbol}`) || c.sim.price,
  tick: tickSize(symbol),
  sizeDecimals: c.sizeDecimals,
  vol: c.sim.vol,
  topNotional: c.sim.topNotional,
  now: Date.now() - 40_000,
});
const ingest = (events) => {
  for (const ev of events) {
    market.ingest(ev);
    if (ev.type === 'trade') heat.addTrade(ev);
  }
};
ingest([sim.snapshotEvent()]);
for (let i = 0; i < 400; i++) {
  ingest(sim.step(0.1));
  heat.sample(sim.clock);
}
let lastStep = performance.now();
setInterval(() => {
  const now = performance.now();
  let dt = Math.min(2, (now - lastStep) / 1000);
  lastStep = now;
  sim.clock = Date.now() - dt * 1000;
  while (dt > 1e-6) {
    const d = Math.min(0.1, dt);
    ingest(sim.step(d));
    dt -= d;
  }
}, 40);

// Mini order book next to the heatmap.
const ROWS = 8;
const bookEl = $('#demo-book');
const mkRow = (side) => h('div', { class: `mini-row ${side}` }, h('span'), h('span'));
const askRows = Array.from({ length: ROWS }, () => mkRow('ask'));
const bidRows = Array.from({ length: ROWS }, () => mkRow('bid'));
const midEl = h('div', { class: 'mini-mid' }, '—');
bookEl.append(...[...askRows].reverse(), midEl, ...bidRows);

function renderBook() {
  const asks = market.book.asks.aggregate(ROWS, 1);
  const bids = market.book.bids.aggregate(ROWS, 1);
  const max = Math.max(...asks.map((l) => l[1]), ...bids.map((l) => l[1]), 1e-9);
  const fill = (rows, levels) =>
    rows.forEach((row, i) => {
      const [p, s] = levels[i] ?? [NaN, 0];
      setText(row.children[0], fmtPrice(p, 0));
      setText(row.children[1], fmtSize(s, 3));
      row.style.setProperty('--depth', (s / max).toFixed(3));
    });
  fill(askRows, asks);
  fill(bidRows, bids);
  const last = market.last;
  setText(midEl, fmtPrice(last, 2));
  setTrend(midEl, last - market.prevPrice);
  setText($('#demo-price'), fmtPrice(last, 2));
}

// Only paint what is on screen.
const onScreen = new Map();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) onScreen.set(e.target, e.isIntersecting);
});
io.observe($('#demo-heat'));
io.observe($('#demo-depth'));

let t = { heat: 0, book: 0, depth: 0 };
function frame(now) {
  if (heat.sample() && onScreen.get($('#demo-heat')) !== false && now - t.heat > 50) {
    t.heat = now;
    heat.render();
  }
  if (now - t.book > 150 && onScreen.get($('#demo-heat')) !== false) {
    t.book = now;
    renderBook();
  }
  if (now - t.depth > 200 && onScreen.get($('#demo-depth'))) {
    t.depth = now;
    depth.render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

onThemeChange(() => {
  heat.readColors();
  depth.readColors();
});

/* ---------------------------------------------------------- ticker strip */

const track = $('#ticker-track');
const cells = {};
const buildSet = (hidden) =>
  SYMBOL_IDS.map((id) => {
    const price = h('span', { class: 'num' }, '—');
    const chg = h('span', { class: 'num' }, '');
    (cells[id] ??= []).push({ price, chg });
    return h(
      'a',
      {
        class: 'tick',
        href: `terminal.html?symbol=${id}`,
        tabindex: hidden ? '-1' : null,
        'aria-hidden': hidden ? 'true' : null,
      },
      h('strong', {}, `${id}-USD`),
      price,
      chg,
    );
  });
// Two copies for a seamless marquee loop; the second is hidden from assistive tech.
track.append(...buildSet(false), ...buildSet(true));

const ticker = new MultiTicker();
ticker.on('tick', (t) => {
  const dec = SYMBOLS[t.symbol].priceDecimals;
  const pct = ((t.last - t.open24h) / t.open24h) * 100;
  for (const c of cells[t.symbol]) {
    setText(c.price, `$${fmtPrice(t.last, dec)}`);
    setText(c.chg, fmtPct(pct));
    setTrend(c.chg, pct);
  }
});
ticker.on('source', (s) => {
  setText(
    $('#ticker-source'),
    s === 'live'
      ? 'Live prices from Coinbase Exchange'
      : 'Simulated prices — the live Coinbase feed is not reachable from this network',
  );
});
ticker.start();
