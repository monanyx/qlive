/**
 * OHLCV candle aggregation from a stream of trades.
 * Bars use UNIX seconds for `time` (the convention lightweight-charts expects).
 */
export class CandleSeries {
  constructor(intervalSec, maxBars = 3000) {
    this.interval = intervalSec;
    this.maxBars = maxBars;
    this.bars = [];
  }

  bucket(tsMs) {
    const sec = Math.floor(tsMs / 1000);
    return sec - (sec % this.interval);
  }

  get last() {
    return this.bars[this.bars.length - 1] ?? null;
  }

  setHistory(bars) {
    this.bars = bars
      .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
      .sort((a, b) => a.time - b.time)
      .slice(-this.maxBars)
      .map((b) => ({ ...b }));
  }

  /**
   * Merge history fetched after live trades already started arriving:
   * historical bars older than the first live bar are prepended, overlapping
   * bars keep the live values (they include the most recent trades).
   */
  mergeHistory(bars) {
    const first = this.bars[0];
    const older = bars.filter((b) => !first || b.time < first.time);
    if (first) {
      const overlap = bars.find((b) => b.time === first.time);
      if (overlap) {
        first.open = overlap.open;
        first.high = Math.max(first.high, overlap.high);
        first.low = Math.min(first.low, overlap.low);
        first.volume = Math.max(first.volume, overlap.volume);
      }
    }
    this.setHistory([...older, ...this.bars]);
  }

  /**
   * Fold a trade into the series.
   * Returns { bar, isNew } or null if the trade predates the current bar.
   */
  addTrade(price, size, tsMs) {
    const t = this.bucket(tsMs);
    const last = this.last;
    if (last && t < last.time) return null;
    if (last && t === last.time) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += size;
      return { bar: last, isNew: false };
    }
    const bar = { time: t, open: price, high: price, low: price, close: price, volume: size };
    this.bars.push(bar);
    if (this.bars.length > this.maxBars) this.bars.splice(0, this.bars.length - this.maxBars);
    return { bar, isNew: true };
  }
}

/** Re-aggregate bars into a coarser interval (e.g. 1m → 15m). */
export function resampleBars(bars, intervalSec) {
  const out = [];
  for (const b of bars) {
    const t = b.time - (b.time % intervalSec);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
  }
  return out;
}
