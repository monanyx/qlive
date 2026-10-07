import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
} from '../../../vendor/lightweight-charts/lightweight-charts.mjs';
import { fmtCompact, fmtDateTime, fmtPct, fmtPrice } from '../core/format.js';
import { alpha, cssVar, setText } from './dom.js';

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Axis labels in the viewer's local time zone (the library defaults to UTC). */
function tickMark(time, type) {
  const d = new Date(time * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return MONTHS[d.getMonth()];
    case TickMarkType.DayOfMonth:
      return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    case TickMarkType.TimeWithSeconds:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    default:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

/**
 * Candlestick + volume chart (TradingView Lightweight Charts™) with overlays
 * for paper-trading fills (markers), open orders and price alerts (lines).
 */
export class CandleChart {
  constructor({ el, legendEl, onAltClick = () => {} }) {
    this.el = el;
    this.legendEl = legendEl;
    this.decimals = 2;
    this.interval = 60;
    this.orderLines = new Map();
    this.alertLines = new Map();
    this.bars = [];

    this.chart = createChart(el, {
      autoSize: true,
      layout: { attributionLogo: true, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.22 } },
      timeScale: { rightOffset: 6, barSpacing: 8, timeVisible: true, tickMarkFormatter: tickMark },
      localization: { timeFormatter: (t) => fmtDateTime(t * 1000), priceFormatter: (p) => fmtPrice(p, this.decimals) },
    });
    this.series = this.chart.addSeries(CandlestickSeries, { priceLineStyle: LineStyle.Dotted });
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.markers = createSeriesMarkers(this.series, []);

    this.chart.subscribeCrosshairMove((param) => {
      const bar = param.time ? param.seriesData.get(this.series) : null;
      this.#legend(bar ?? this.bars[this.bars.length - 1]);
    });

    el.addEventListener('click', (e) => {
      if (!e.altKey) return;
      const rect = el.getBoundingClientRect();
      const price = this.series.coordinateToPrice(e.clientY - rect.top);
      if (Number.isFinite(price)) onAltClick(price);
    });

    this.applyTheme();
  }

  applyTheme() {
    const up = cssVar('--up');
    const down = cssVar('--down');
    this.colors = {
      up,
      down,
      text: cssVar('--text-2'),
      line: cssVar('--line'),
      accent: cssVar('--accent'),
      warn: cssVar('--warn'),
    };
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: this.colors.text },
      grid: { vertLines: { color: this.colors.line }, horzLines: { color: this.colors.line } },
      rightPriceScale: { borderColor: this.colors.line },
      timeScale: { borderColor: this.colors.line },
      crosshair: {
        vertLine: { color: cssVar('--text-3'), labelBackgroundColor: cssVar('--surface-3') },
        horzLine: { color: cssVar('--text-3'), labelBackgroundColor: cssVar('--surface-3') },
      },
    });
    this.series.applyOptions({
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    });
    if (this.bars.length) this.volume.setData(this.bars.map((b) => this.#vol(b)));
  }

  #vol(b) {
    const c = b.close >= b.open ? this.colors.up : this.colors.down;
    return { time: b.time, value: b.volume, color: alpha(c, 0.38) };
  }

  setFormat(decimals, intervalSec) {
    this.decimals = decimals;
    this.interval = intervalSec;
    const minMove = Number((1 / 10 ** decimals).toFixed(decimals));
    this.series.applyOptions({ priceFormat: { type: 'price', precision: decimals, minMove } });
    this.chart.applyOptions({ timeScale: { secondsVisible: intervalSec < 60, barSpacing: intervalSec < 60 ? 6 : 8 } });
  }

  setBars(bars) {
    this.bars = bars.map((b) => ({ ...b }));
    this.series.setData(this.bars);
    this.volume.setData(this.bars.map((b) => this.#vol(b)));
    this.chart.timeScale().scrollToRealTime();
    this.#legend(this.bars[this.bars.length - 1]);
  }

  /** Update or append the latest bar. */
  update(bar) {
    const last = this.bars[this.bars.length - 1];
    if (last && bar.time < last.time) return;
    if (last && last.time === bar.time) Object.assign(last, bar);
    else this.bars.push({ ...bar });
    this.series.update(bar);
    this.volume.update(this.#vol(bar));
  }

  #legend(bar) {
    if (!this.legendEl) return;
    if (!bar) {
      setText(this.legendEl, '');
      return;
    }
    const d = this.decimals;
    const chg = ((bar.close - bar.open) / bar.open) * 100;
    const cls = bar.close >= bar.open ? 'up' : 'down';
    const parts = [
      ['O', fmtPrice(bar.open, d)],
      ['H', fmtPrice(bar.high, d)],
      ['L', fmtPrice(bar.low, d)],
      ['C', fmtPrice(bar.close, d)],
      ['', fmtPct(chg)],
      ['Vol', fmtCompact(bar.volume ?? this.bars.find((b) => b.time === bar.time)?.volume ?? NaN)],
    ];
    const key = parts.map((p) => p.join(' ')).join('|');
    if (this.legendKey === key) return;
    this.legendKey = key;
    this.legendEl.replaceChildren(
      ...parts.map(([k, v]) => {
        const span = document.createElement('span');
        if (k) {
          span.append(`${k} `);
          const b = document.createElement('b');
          b.textContent = v;
          b.className = k === 'Vol' ? '' : cls;
          span.append(b);
        } else {
          span.textContent = v;
          span.className = cls;
        }
        return span;
      }),
    );
  }

  /** Paper-trading fills as arrows on the candle they happened in. */
  setFills(fills) {
    const first = this.bars[0]?.time ?? Infinity;
    const markers = fills
      .map((f) => ({
        time: Math.floor(f.ts / 1000) - (Math.floor(f.ts / 1000) % this.interval),
        position: f.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: f.side === 'buy' ? this.colors.up : this.colors.down,
        text: `${f.side === 'buy' ? 'B' : 'S'} ${fmtPrice(f.price, this.decimals)}`,
        id: f.id,
      }))
      .filter((m) => m.time >= first)
      .sort((a, b) => a.time - b.time)
      .slice(-60);
    this.markers.setMarkers(markers);
  }

  /** Dashed lines for open limit/stop orders. */
  setOrders(orders) {
    this.#syncLines(this.orderLines, orders, (o) => ({
      price: o.type === 'stop' ? o.stopPrice : o.price,
      color: o.side === 'buy' ? this.colors.up : this.colors.down,
      lineWidth: 1,
      lineStyle: o.type === 'stop' ? LineStyle.Dotted : LineStyle.Dashed,
      axisLabelVisible: true,
      title: `${o.type === 'stop' ? 'STOP ' : ''}${o.side.toUpperCase()} ${+(o.qty - o.filled).toPrecision(6)}`,
    }));
  }

  setAlerts(alerts) {
    this.#syncLines(this.alertLines, alerts, (a) => ({
      price: a.price,
      color: this.colors.warn,
      lineWidth: 1,
      lineStyle: LineStyle.SparseDotted,
      axisLabelVisible: true,
      title: 'ALERT',
    }));
  }

  #syncLines(map, items, opts) {
    const ids = new Set(items.map((i) => i.id));
    for (const [id, line] of map) {
      if (!ids.has(id)) {
        this.series.removePriceLine(line);
        map.delete(id);
      }
    }
    for (const item of items) {
      const o = opts(item);
      const line = map.get(item.id);
      if (line) line.applyOptions(o);
      else map.set(item.id, this.series.createPriceLine(o));
    }
  }

  clearOverlays() {
    this.#syncLines(this.orderLines, [], () => ({}));
    this.#syncLines(this.alertLines, [], () => ({}));
    this.markers.setMarkers([]);
  }

  destroy() {
    this.chart.remove();
  }
}
