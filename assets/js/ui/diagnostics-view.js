import { fmtBytes, fmtMs, fmtTimeMs } from '../core/format.js';
import { STAGES } from '../metrics/latency.js';
import { $, alpha, cssVar, fitCanvas, h, setText } from './dom.js';

/**
 * Diagnostics: per-stage latency percentiles, histograms, throughput and a
 * connection event log.
 */
export class DiagnosticsView {
  constructor({ root, latency, scheduler, market, feeds }) {
    this.root = root;
    this.latency = latency;
    this.scheduler = scheduler;
    this.market = market;
    this.feeds = feeds;
    this.log = [];
    this.tbody = $('[data-diag="stages"]', root);
    this.kv = $('[data-diag="kv"]', root);
    this.logEl = $('[data-diag="log"]', root);
    this.histLag = $('[data-diag="hist-feed"]', root);
    this.histRender = $('[data-diag="hist-render"]', root);
    this.rows = {};
    for (const [key, s] of Object.entries(STAGES)) {
      const cells = Array.from({ length: 6 }, () => h('td', { class: 'r' }));
      const row = h('tr', { title: s.hint }, h('td', {}, s.label), ...cells);
      this.rows[key] = cells;
      this.tbody.append(row);
    }
    this.kvCells = {};
    for (const k of [
      'Endpoint',
      'State',
      'Messages/s',
      'Events/s',
      'Bandwidth',
      'Paints/s',
      'Book levels',
      'Trades buffered',
      'Book updated',
      'Timer precision',
    ]) {
      const dd = h('dd');
      this.kvCells[k] = dd;
      this.kv.append(h('dt', {}, k), dd);
    }
  }

  addLog(text) {
    this.log.unshift({ t: Date.now(), text });
    if (this.log.length > 60) this.log.length = 60;
    this.logDirty = true;
  }

  render() {
    if (this.root.closest('[hidden]')) return;
    const L = this.latency;
    for (const [key, cells] of Object.entries(this.rows)) {
      const s = L.stats(key);
      const vals = [s.last, s.p50, s.p95, s.p99, s.max];
      vals.forEach((v, i) => setText(cells[i], s.count ? fmtMs(v) : '—'));
      setText(cells[5], String(s.count));
    }
    const st = this.feeds.status ?? {};
    const k = this.kvCells;
    setText(
      k.Endpoint,
      st.exchange === 'sim'
        ? 'in-browser simulator'
        : st.detail && st.state === 'open'
          ? st.detail
          : (this.endpoint ?? '—'),
    );
    setText(k.State, `${st.state ?? '—'}${st.fallback ? ' (fallback)' : ''}`);
    setText(k['Messages/s'], L.messages.rate().toFixed(1));
    setText(k['Events/s'], L.events.rate().toFixed(1));
    setText(k.Bandwidth, st.exchange === 'sim' ? 'n/a' : `${fmtBytes(L.bytes.rate())}/s`);
    const recent = performance.now() - this.scheduler.lastFrame < 1500;
    setText(k['Paints/s'], recent ? this.scheduler.fps.toFixed(0) : '0');
    setText(k['Book levels'], `${this.market.book.bids.length} / ${this.market.book.asks.length}`);
    setText(k['Trades buffered'], String(this.market.trades.length));
    setText(k['Book updated'], this.market.book.updatedAt ? fmtTimeMs(this.market.book.updatedAt) : '—');
    setText(k['Timer precision'], crossOriginIsolated ? '≈5 µs (isolated)' : '≈100 µs (coarsened)');
    if (st.state === 'open' && st.detail) this.endpoint = st.detail;

    this.#hist(this.histLag, 'feed', cssVar('--accent'));
    this.#hist(this.histRender, 'render', cssVar('--accent-2'));

    if (this.logDirty) {
      this.logDirty = false;
      this.logEl.replaceChildren(...this.log.map((l) => h('li', {}, h('time', {}, fmtTimeMs(l.t)), l.text)));
    }
  }

  #hist(canvas, stage, color) {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h: hh } = fit;
    const bins = 28;
    const counts = this.latency.histogram(stage, bins, 0.001, 1000);
    const max = Math.max(1, ...counts);
    ctx.clearRect(0, 0, w, hh);
    const bw = w / bins;
    ctx.fillStyle = alpha(color, 0.75);
    counts.forEach((c, i) => {
      const bh = (c / max) * (hh - 14);
      ctx.fillRect(i * bw + 1, hh - 12 - bh, bw - 2, bh);
    });
    ctx.fillStyle = cssVar('--text-3');
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText('1 µs', 2, hh);
    ctx.textAlign = 'center';
    ctx.fillText('1 ms', w / 2, hh);
    ctx.textAlign = 'right';
    ctx.fillText('1 s', w - 2, hh);
  }
}
