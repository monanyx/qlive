import { decimalsOf } from '../core/config.js';
import { fmtCompact, fmtPrice, fmtTime } from '../core/format.js';
import { alpha, cssVar, fitCanvas, getThemeName } from './dom.js';

const BINS = 360; // price bins across the visible range

/**
 * Liquidity heatmap (Bookmap-style): time runs left → right, price bottom →
 * top, colour = resting size at that price. Best bid/ask are drawn as lines
 * and trades as bubbles sized by notional — so you can watch liquidity get
 * pulled, refilled and swept in real time.
 *
 * Each sampled column is pre-binned onto an absolute price grid and stored
 * sparsely. The bitmap is drawn incrementally (shift left + paint one new
 * column) and fully redrawn only on resize, recentre or theme change.
 */
export class LiquidityHeatmap {
  constructor({ canvas, tip = null, market, config, columnMs = 200, colW = 3, rangePct = 0.0035, axis = true }) {
    this.canvas = canvas;
    this.tip = tip;
    this.market = market;
    this.config = config;
    this.columnMs = columnMs;
    this.colW = colW;
    this.rangePct = rangePct;
    this.axis = axis;
    this.buf = document.createElement('canvas');
    this.reset();
    this.readColors();

    if (tip) {
      canvas.addEventListener('mousemove', (e) => this.#hover(e.offsetX, e.offsetY));
      canvas.addEventListener('mouseleave', () => {
        tip.hidden = true;
      });
    }
  }

  reset() {
    this.columns = [];
    this.pendingTrades = [];
    this.binSize = 0;
    this.center = null;
    this.ref = 0;
    this.lastSample = 0;
    this.needsFull = true;
    this.newCols = 0;
  }

  readColors() {
    const light = getThemeName() === 'light';
    this.c = {
      bg: light ? '#ffffff' : '#04060b',
      up: cssVar('--up'),
      down: cssVar('--down'),
      text: cssVar('--text-3'),
      line: cssVar('--line'),
      axisBg: cssVar('--surface'),
    };
    // Colour ramp: background → blue → cyan → yellow → white (dark) /
    // background → sky → violet → orange → red (light).
    const stops = light
      ? [
          [255, 255, 255],
          [186, 220, 247],
          [96, 120, 230],
          [168, 64, 200],
          [245, 130, 40],
          [210, 20, 40],
        ]
      : [
          [4, 6, 11],
          [16, 32, 92],
          [20, 110, 190],
          [34, 211, 238],
          [250, 214, 70],
          [255, 255, 255],
        ];
    this.ramp = Array.from({ length: 96 }, (_, i) => {
      const t = (i / 95) * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(t));
      const f = t - k;
      const [a, b] = [stops[k], stops[k + 1]];
      return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`;
    });
    this.needsFull = true;
  }

  /** Feed a trade print (attached to the next sampled column). */
  addTrade(t) {
    if (!t.replay) this.pendingTrades.push([t.price, t.size, t.side === 'buy' ? 1 : -1]);
  }

  /** Sample the current book into a new column if the interval has elapsed. */
  sample(now = Date.now()) {
    if (now - this.lastSample < this.columnMs) return false;
    const book = this.market.book;
    const mid = book.mid;
    if (!Number.isFinite(mid)) return false;
    this.lastSample = now;

    if (!this.binSize) {
      this.binSize = (mid * this.rangePct * 2) / BINS;
      this.center = Math.round(mid / this.binSize);
    }
    const bs = this.binSize;
    const midBin = Math.round(mid / bs);
    if (Math.abs(midBin - this.center) > BINS * 0.32) {
      this.center = midBin;
      this.needsFull = true;
    }

    // Bin both sides within ±1.5× the visible half-range.
    const span = Math.round(BINS * 0.75);
    const loBin = midBin - span;
    const hiBin = midBin + span;
    const acc = new Map();
    const add = (side, isBid) => {
      for (const p of side.prices) {
        const b = Math.floor(p / bs);
        if (isBid ? b < loBin : b > hiBin) break;
        acc.set(b, (acc.get(b) ?? 0) + side.sizes.get(p));
      }
    };
    add(book.bids, true);
    add(book.asks, false);
    const idx = new Int32Array(acc.size);
    const size = new Float32Array(acc.size);
    let i = 0;
    for (const [b, s] of acc) {
      idx[i] = b;
      size[i++] = s;
    }

    // Adaptive intensity reference: EMA of the 92nd percentile bin size.
    if (size.length) {
      const sorted = Float32Array.from(size).sort();
      const q = sorted[Math.floor(sorted.length * 0.92)];
      this.ref = this.ref ? this.ref * 0.97 + q * 0.03 : q;
    }

    this.columns.push({ t: now, idx, size, bb: book.bestBid, ba: book.bestAsk, trades: this.pendingTrades });
    this.pendingTrades = [];
    const keep = Math.ceil(2400 / this.colW) + 4;
    if (this.columns.length > keep) this.columns.splice(0, this.columns.length - keep);
    this.newCols++;
    return true;
  }

  #geom(w, h) {
    const axisW = this.axis ? 70 : 0;
    const plotW = w - axisW;
    const rowH = h / BINS;
    const topBin = this.center + BINS / 2;
    return { axisW, plotW, rowH, topBin };
  }

  #drawColumn(ctx, col, x, g) {
    const { rowH, topBin } = g;
    const ref = this.ref || 1;
    const k = 5;
    const norm = Math.log1p(k * 2);
    for (let i = 0; i < col.idx.length; i++) {
      const row = topBin - col.idx[i];
      if (row < 0 || row >= BINS) continue;
      const v = Math.log1p((k * col.size[i]) / ref) / norm;
      if (v < 0.05) continue;
      ctx.fillStyle = this.ramp[Math.min(95, Math.floor(v * 95))];
      ctx.fillRect(x, Math.floor(row * rowH), this.colW, Math.max(1, Math.ceil(rowH)));
    }
  }

  render() {
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { ctx, w, h, dpr } = fit;
    const g = this.#geom(w, h);
    const { plotW, axisW, rowH, topBin } = g;

    // Off-screen bitmap of the heat columns.
    const bw = Math.round(plotW * dpr);
    const bh = Math.round(h * dpr);
    if (this.buf.width !== bw || this.buf.height !== bh) {
      this.buf.width = bw;
      this.buf.height = bh;
      this.needsFull = true;
    }
    const bctx = this.buf.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const visible = Math.ceil(plotW / this.colW);
    const cols = this.columns;

    if (this.needsFull || this.newCols >= visible) {
      bctx.fillStyle = this.c.bg;
      bctx.fillRect(0, 0, plotW, h);
      const start = Math.max(0, cols.length - visible);
      for (let i = start; i < cols.length; i++)
        this.#drawColumn(bctx, cols[i], plotW - (cols.length - i) * this.colW, g);
      this.needsFull = false;
    } else if (this.newCols > 0) {
      const shift = this.newCols * this.colW;
      bctx.save();
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.drawImage(this.buf, -Math.round(shift * dpr), 0);
      bctx.restore();
      bctx.fillStyle = this.c.bg;
      bctx.fillRect(plotW - shift, 0, shift, h);
      for (let i = cols.length - this.newCols; i < cols.length; i++) {
        this.#drawColumn(bctx, cols[i], plotW - (cols.length - i) * this.colW, g);
      }
    }
    this.newCols = 0;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.buf, 0, 0, plotW, h);

    if (!cols.length || !this.binSize) {
      ctx.fillStyle = this.c.text;
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Building liquidity history…', plotW / 2, h / 2);
      return;
    }

    const bs = this.binSize;
    const yOf = (p) => (topBin - p / bs) * rowH;
    const start = Math.max(0, cols.length - visible);

    // Best bid / ask lines.
    const line = (key, color) => {
      ctx.beginPath();
      let started = false;
      for (let i = start; i < cols.length; i++) {
        const v = cols[i][key];
        if (!Number.isFinite(v)) continue;
        const x = plotW - (cols.length - i) * this.colW;
        const y = yOf(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
        ctx.lineTo(x + this.colW, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    line('bb', this.c.up);
    line('ba', this.c.down);

    // Trade bubbles.
    for (let i = start; i < cols.length; i++) {
      const x = plotW - (cols.length - i) * this.colW + this.colW / 2;
      for (const [p, s, side] of cols[i].trades) {
        const r = Math.min(16, 1.8 + 2.6 * Math.log10(1 + (p * s) / 500));
        ctx.beginPath();
        ctx.arc(x, yOf(p), r, 0, Math.PI * 2);
        ctx.fillStyle = alpha(side > 0 ? this.c.up : this.c.down, 0.55);
        ctx.fill();
        if (r > 6) {
          ctx.strokeStyle = alpha(side > 0 ? this.c.up : this.c.down, 0.95);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    if (this.axis) this.#axis(ctx, w, h, plotW, axisW, yOf);
  }

  #axis(ctx, w, h, plotW, axisW, yOf) {
    const { tick } = this.config();
    const lo = (this.center - BINS / 2) * this.binSize;
    const hi = (this.center + BINS / 2) * this.binSize;
    ctx.fillStyle = this.c.axisBg;
    ctx.fillRect(plotW, 0, axisW, h);
    ctx.strokeStyle = this.c.line;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, h);
    ctx.stroke();
    // "Nice" label step targeting ~45 px spacing.
    const raw = ((hi - lo) / h) * 45;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const dec = Math.max(decimalsOf(tick) > 2 ? decimalsOf(tick) - 1 : 0, decimalsOf(step));
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.c.text;
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const y = yOf(p);
      if (y < 8 || y > h - 8) continue;
      ctx.fillText(fmtPrice(p, dec), plotW + 8, y);
    }
    const mid = this.market.book.mid;
    if (Number.isFinite(mid)) {
      const y = Math.max(9, Math.min(h - 9, yOf(mid)));
      ctx.fillStyle = cssVar('--accent');
      ctx.fillRect(plotW + 2, y - 9, axisW - 4, 18);
      ctx.fillStyle = cssVar('--accent-ink');
      ctx.fillText(fmtPrice(mid, decimalsOf(tick)), plotW + 6, y);
    }
  }

  #hover(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const g = this.#geom(r.width, r.height);
    if (!this.binSize || x > g.plotW) {
      this.tip.hidden = true;
      return;
    }
    const i = this.columns.length - Math.ceil((g.plotW - x) / this.colW);
    const col = this.columns[i];
    if (!col) {
      this.tip.hidden = true;
      return;
    }
    const bin = Math.round(g.topBin - y / g.rowH);
    let s = 0;
    for (let k = 0; k < col.idx.length; k++) if (col.idx[k] === bin) s = col.size[k];
    const { tick } = this.config();
    this.tip.hidden = false;
    this.tip.textContent = `${fmtTime(col.t)}  ${fmtPrice(bin * this.binSize, decimalsOf(tick))}  resting ${fmtCompact(s)}`;
    this.tip.style.transform = `translate(${Math.min(x + 12, g.plotW - this.tip.offsetWidth - 4)}px, ${Math.max(4, y - 30)}px)`;
  }
}
