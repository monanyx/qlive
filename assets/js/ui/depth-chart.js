import { decimalsOf } from '../core/config.js';
import { fmtCompact, fmtPct, fmtPrice, fmtSize, fmtUsd } from '../core/format.js';
import { alpha, cssVar, fitCanvas } from './dom.js';

/**
 * Cumulative depth chart: bids (left) and asks (right) as stepped areas
 * around the mid price. Mouse wheel / buttons zoom the visible range;
 * hovering shows cumulative size and notional to that price.
 */
export class DepthChart {
  constructor({ canvas, tip, market, config }) {
    this.canvas = canvas;
    this.tip = tip;
    this.market = market;
    this.config = config;
    this.range = 0.005; // ±0.5 % around mid
    this.hoverX = null;
    this.readColors();

    canvas.addEventListener('mousemove', (e) => {
      this.hoverX = e.offsetX;
      this.render();
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.tip.hidden = true;
      this.render();
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false },
    );
  }

  zoom(f) {
    this.range = Math.min(0.08, Math.max(0.0005, this.range * f));
    this.render();
  }

  readColors() {
    this.c = {
      up: cssVar('--up'),
      down: cssVar('--down'),
      text: cssVar('--text-3'),
      text2: cssVar('--text-2'),
      line: cssVar('--line'),
      accent: cssVar('--accent'),
    };
  }

  render() {
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const { tick, sizeDecimals } = this.config();
    const dec = decimalsOf(tick);
    const book = this.market.book;
    ctx.clearRect(0, 0, w, h);
    const c = this.c;

    const curve = book.depthCurve(this.range);
    const mid = curve.mid;
    if (!Number.isFinite(mid) || (!curve.bids.length && !curve.asks.length)) {
      ctx.fillStyle = c.text;
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for order book…', w / 2, h / 2);
      return;
    }

    const padL = 8;
    const padR = 64;
    const padT = 14;
    const padB = 24;
    const lo = mid * (1 - this.range);
    const hi = mid * (1 + this.range);
    const maxCum = Math.max(curve.bids.at(-1)?.[1] ?? 0, curve.asks.at(-1)?.[1] ?? 0) * 1.08 || 1;
    const x = (p) => padL + ((p - lo) / (hi - lo)) * (w - padL - padR);
    const y = (v) => h - padB - (v / maxCum) * (h - padT - padB);

    // Grid + axes
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = c.text;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (maxCum / 4) * i;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(v >= 1000 ? fmtCompact(v) : fmtSize(v, Math.min(2, sizeDecimals)), w - padR + 6, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const p = lo + ((hi - lo) / 4) * i;
      ctx.textAlign = i === 0 ? 'left' : 'center';
      ctx.fillText(fmtPrice(p, dec), x(p), h - padB + 7);
    }
    ctx.textAlign = 'center';

    const area = (pts, color, toEdge) => {
      if (!pts.length) return;
      ctx.beginPath();
      ctx.moveTo(x(pts[0][0]), y(0));
      let prev = 0;
      for (const [p, cum] of pts) {
        ctx.lineTo(x(p), y(prev));
        ctx.lineTo(x(p), y(cum));
        prev = cum;
      }
      ctx.lineTo(x(toEdge), y(prev));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.lineTo(x(toEdge), y(0));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, h - padB);
      g.addColorStop(0, alpha(color, 0.38));
      g.addColorStop(1, alpha(color, 0.04));
      ctx.fillStyle = g;
      ctx.fill();
    };
    area(curve.bids, c.up, lo);
    area(curve.asks, c.down, hi);

    // Mid line
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = c.text2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(mid)) + 0.5, padT);
    ctx.lineTo(Math.round(x(mid)) + 0.5, h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.text2;
    ctx.textBaseline = 'top';
    ctx.fillText(`mid ${fmtPrice(mid, dec)}`, x(mid), 2);

    // Hover readout
    if (this.hoverX != null && this.hoverX > padL && this.hoverX < w - padR) {
      const p = lo + ((this.hoverX - padL) / (w - padL - padR)) * (hi - lo);
      const isBid = p < mid;
      const side = isBid ? book.bids : book.asks;
      let cum = 0;
      let notional = 0;
      for (const lp of side.prices) {
        if (isBid ? lp < p : lp > p) break;
        const s = side.sizes.get(lp);
        cum += s;
        notional += s * lp;
      }
      ctx.strokeStyle = isBid ? c.up : c.down;
      ctx.beginPath();
      ctx.moveTo(this.hoverX + 0.5, padT);
      ctx.lineTo(this.hoverX + 0.5, h - padB);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.hoverX, y(Math.min(cum, maxCum)), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isBid ? c.up : c.down;
      ctx.fill();
      this.tip.hidden = false;
      this.tip.textContent = `${fmtPrice(p, dec)} (${fmtPct(((p - mid) / mid) * 100)})  Σ ${fmtSize(cum, sizeDecimals)}  ${fmtUsd(notional, 0)}`;
      const tx = Math.min(this.hoverX + 12, w - this.tip.offsetWidth - 8);
      this.tip.style.transform = `translate(${Math.max(4, tx)}px, ${padT + 4}px)`;
    }
  }
}
