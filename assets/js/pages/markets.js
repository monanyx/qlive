import { SYMBOLS, SYMBOL_IDS } from '../core/config.js';
import { fmtCompact, fmtPct, fmtPrice, fmtUsd } from '../core/format.js';
import { storage } from '../core/storage.js';
import { fetchHistory } from '../feeds/history.js';
import { MultiTicker } from '../feeds/multi-ticker.js';
import { $, $$, choiceGroup, h, icon, setText, setTrend } from '../ui/dom.js';
import { initSite } from '../ui/site.js';
import { createSparkline } from '../ui/sparkline.js';

initSite();

const COLORS = { BTC: '#f7931a', ETH: '#627eea', SOL: '#9945ff', XRP: '#52606d', DOGE: '#c2a633' };

const starred = new Set(storage.get('watchlist', []));
let sort = { key: 'change', dir: -1 };
let filter = '';
let view = 'all';

/* --------------------------------------------------------------- rows */

const tbody = $('#rows');
const rows = {};

for (const id of SYMBOL_IDS) {
  const c = SYMBOLS[id];
  const spark = createSparkline({ label: `${id} price over the last 24 hours` });
  const star = h(
    'button',
    {
      type: 'button',
      class: 'star',
      'aria-pressed': String(starred.has(id)),
      'aria-label': `Star ${id}`,
      dataset: { star: id },
    },
    icon('star', 'icon icon--sm'),
  );
  const cells = {
    last: h('td', { class: 'r' }, '—'),
    change: h('span', { class: 'change-pill' }, '—'),
    high: h('td', { class: 'r hide-sm' }, '—'),
    low: h('td', { class: 'r hide-sm' }, '—'),
    volume: h('td', { class: 'r hide-sm' }, '—'),
  };
  const tr = h(
    'tr',
    { tabindex: '0', dataset: { symbol: id }, 'aria-label': `${c.name} ${id}-USD — open in terminal` },
    h('td', {}, star),
    h(
      'td',
      {},
      h(
        'div',
        { class: 'coin' },
        h('span', { class: 'coin__icon', style: { background: COLORS[id] } }, id.slice(0, 3)),
        h('div', { class: 'coin__name' }, h('strong', {}, `${id}-USD`), h('span', {}, c.name)),
      ),
    ),
    cells.last,
    h('td', { class: 'r' }, cells.change),
    cells.high,
    cells.low,
    cells.volume,
    h('td', { class: 'r hide-sm' }, spark.el),
    h(
      'td',
      { class: 'r hide-sm' },
      h('a', { class: 'btn btn--sm btn--outline', href: `terminal.html?symbol=${id}`, tabindex: '-1' }, 'Trade'),
    ),
  );
  tbody.append(tr);
  rows[id] = { id, tr, cells, spark, star, series: [], data: {} };
}

tbody.addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    const id = star.dataset.star;
    if (starred.has(id)) starred.delete(id);
    else starred.add(id);
    storage.set('watchlist', [...starred]);
    star.setAttribute('aria-pressed', String(starred.has(id)));
    applyView();
    return;
  }
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr[data-symbol]');
  if (tr) location.href = `terminal.html?symbol=${tr.dataset.symbol}`;
});
tbody.addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-symbol]');
  if (tr && e.key === 'Enter' && e.target === tr) location.href = `terminal.html?symbol=${tr.dataset.symbol}`;
});

/* -------------------------------------------------------- sort & filter */

const value = (r, key) => {
  const d = r.data;
  switch (key) {
    case 'symbol':
      return r.id;
    case 'change':
      return d.change;
    case 'volume':
      return d.volume24h * d.last;
    default:
      return d[key];
  }
};

function applyView() {
  const list = Object.values(rows);
  list.sort((a, b) => {
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    if (typeof va === 'string') return va.localeCompare(vb) * sort.dir;
    return ((Number.isFinite(va) ? va : -Infinity) - (Number.isFinite(vb) ? vb : -Infinity)) * sort.dir;
  });
  let shown = 0;
  for (const r of list) {
    const q = filter.toLowerCase();
    const match = !q || r.id.toLowerCase().includes(q) || SYMBOLS[r.id].name.toLowerCase().includes(q);
    const visible = match && (view === 'all' || starred.has(r.id));
    r.tr.hidden = !visible;
    if (visible) shown++;
    tbody.append(r.tr);
  }
  $('#empty').hidden = shown > 0;
  if (!shown)
    setText(
      $('#empty'),
      view === 'starred' && !starred.size
        ? 'Star a market to add it to your watchlist.'
        : 'No markets match your filter.',
    );
}

for (const btn of $$('[data-sort]')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    sort = { key, dir: sort.key === key ? -sort.dir : key === 'symbol' ? 1 : -1 };
    for (const b of $$('[data-sort]')) {
      b.setAttribute('aria-sort', b === btn ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    }
    applyView();
  });
}

$('#filter').addEventListener('input', (e) => {
  filter = e.target.value.trim();
  applyView();
});

choiceGroup($('#view'), {
  onChange: (v) => {
    view = v;
    applyView();
  },
});

/* --------------------------------------------------------------- data */

let resortTimer = 0;

function renderRow(t) {
  const r = rows[t.symbol];
  const dec = SYMBOLS[t.symbol].priceDecimals;
  const prev = r.data.last;
  const change = ((t.last - t.open24h) / t.open24h) * 100;
  r.data = { ...t, change };
  setText(r.cells.last, `$${fmtPrice(t.last, dec)}`);
  setText(r.cells.change, fmtPct(change));
  r.cells.change.className = `change-pill ${change >= 0 ? 'up' : 'down'}`;
  setTrend(r.cells.change, change);
  setText(r.cells.high, fmtPrice(t.high24h, dec));
  setText(r.cells.low, fmtPrice(t.low24h, dec));
  setText(r.cells.volume, `$${fmtCompact(t.volume24h * t.last)}`);
  if (Number.isFinite(prev) && prev !== t.last) {
    r.cells.last.classList.remove('flash-up', 'flash-down');
    void r.cells.last.offsetWidth; // restart the animation
    r.cells.last.classList.add(t.last > prev ? 'flash-up' : 'flash-down');
  }
  if (r.liveSeries) {
    r.series.push(t.last);
    if (r.series.length > 300) r.series.shift();
    r.spark.update(r.series);
  }
  renderOverview();
  clearTimeout(resortTimer);
  resortTimer = setTimeout(applyView, 400);
}

function renderOverview() {
  const list = Object.values(rows).filter((r) => Number.isFinite(r.data.change));
  if (!list.length) return;
  const best = list.reduce((a, b) => (b.data.change > a.data.change ? b : a));
  const worst = list.reduce((a, b) => (b.data.change < a.data.change ? b : a));
  setText($('#ov-gainer'), `${best.id} ${fmtPct(best.data.change)}`);
  setTrend($('#ov-gainer'), best.data.change);
  setText($('#ov-loser'), `${worst.id} ${fmtPct(worst.data.change)}`);
  setTrend($('#ov-loser'), worst.data.change);
  const vol = list.reduce((a, r) => a + (r.data.volume24h * r.data.last || 0), 0);
  setText($('#ov-volume'), fmtUsd(vol, 0));
}

async function loadSparklines(source) {
  await Promise.all(
    SYMBOL_IDS.map(async (id) => {
      const r = rows[id];
      if (source === 'sim') {
        r.series = ticker.simSeries(id) ?? [];
      } else {
        const bars = await fetchHistory('coinbase', id, 3600, { limit: 24 });
        r.series = bars.map((b) => b.close);
      }
      // Without history, build the sparkline from live ticks instead.
      r.liveSeries = r.series.length < 2;
      r.spark.update(r.series);
    }),
  );
}

const ticker = new MultiTicker();
ticker.on('tick', (t) => {
  const r = rows[t.symbol];
  if (r.liveSeries === undefined) r.liveSeries = false;
  if (!r.liveSeries && ticker.source === 'sim' && r.series.length) {
    // Keep the simulated sparkline moving with the simulated price.
    r.series[r.series.length - 1] = t.last;
    r.spark.update(r.series);
  }
  renderRow(t);
});
ticker.on('source', (s) => {
  $('#source-dot').className = `dot ${s === 'live' ? 'dot--live' : 'dot--sim'}`;
  setText($('#source-text'), s === 'live' ? 'Live · Coinbase Exchange' : 'Simulated · live feed unreachable');
  loadSparklines(s);
});
ticker.start();
applyView();
