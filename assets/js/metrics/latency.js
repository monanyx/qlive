/**
 * Latency & throughput instrumentation.
 *
 * Each pipeline stage (parse → apply → render, plus the exchange → client
 * "feed lag") records samples into a fixed-size ring buffer. Percentiles are
 * computed on demand from a sorted copy, which is cheap for ~1k samples and
 * only happens when the diagnostics view refreshes (a few times a second).
 *
 * Timer resolution note: browsers coarsen performance.now() (to 5–100 µs
 * depending on cross-origin isolation) to mitigate timing attacks, so sub-µs
 * figures are not meaningful; values are reported in µs/ms accordingly.
 */
export class RingBuffer {
  constructor(capacity = 1024) {
    this.data = new Float64Array(capacity);
    this.capacity = capacity;
    this.size = 0;
    this.head = 0;
  }

  push(v) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  values() {
    if (this.size < this.capacity) return this.data.slice(0, this.size);
    return Float64Array.from({ length: this.capacity }, (_, i) => this.data[(this.head + i) % this.capacity]);
  }

  /** Most recent value. */
  last() {
    return this.size ? this.data[(this.head - 1 + this.capacity) % this.capacity] : NaN;
  }

  clear() {
    this.size = 0;
    this.head = 0;
  }
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values) {
  if (!values.length) return { count: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN };
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

/** Events-per-second counter over a sliding window of 1 s buckets. */
export class RateCounter {
  constructor(windowSec = 5, now = () => Date.now()) {
    this.windowSec = windowSec;
    this.now = now;
    this.buckets = new Map();
    this.total = 0;
  }

  add(n = 1) {
    const sec = Math.floor(this.now() / 1000);
    this.buckets.set(sec, (this.buckets.get(sec) ?? 0) + n);
    this.total += n;
    if (this.buckets.size > this.windowSec + 2) this.#prune(sec);
  }

  #prune(sec) {
    for (const k of this.buckets.keys()) if (k < sec - this.windowSec) this.buckets.delete(k);
  }

  /** Average rate per second over the last complete `windowSec` seconds. */
  rate() {
    const sec = Math.floor(this.now() / 1000);
    this.#prune(sec);
    let sum = 0;
    for (const [k, v] of this.buckets) if (k < sec && k >= sec - this.windowSec) sum += v;
    return sum / this.windowSec;
  }

  reset() {
    this.buckets.clear();
    this.total = 0;
  }
}

export const STAGES = {
  feed: { label: 'Feed lag', hint: 'Exchange event timestamp → message received (includes clock skew)' },
  parse: { label: 'Parse', hint: 'JSON.parse + normalisation of one message' },
  apply: { label: 'Apply', hint: 'Applying a normalised event to the book / tape / candles' },
  render: { label: 'Render', hint: 'Work done in one animation frame to repaint dirty views' },
  frame: { label: 'Frame interval', hint: 'Time between consecutive animation frames' },
};

export class LatencyMonitor {
  constructor({ capacity = 1024, now } = {}) {
    this.capacity = capacity;
    this.stages = new Map();
    this.messages = new RateCounter(5, now);
    this.bytes = new RateCounter(5, now);
    this.events = new RateCounter(5, now);
    this.lastMessageAt = 0;
  }

  #buf(stage) {
    let b = this.stages.get(stage);
    if (!b) this.stages.set(stage, (b = new RingBuffer(this.capacity)));
    return b;
  }

  record(stage, ms) {
    if (Number.isFinite(ms)) this.#buf(stage).push(ms);
  }

  /** Time a synchronous function and record it under `stage`. */
  measure(stage, fn) {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.record(stage, performance.now() - t0);
    }
  }

  message(bytes, at = Date.now()) {
    this.messages.add(1);
    this.bytes.add(bytes);
    this.lastMessageAt = at;
  }

  stats(stage) {
    const b = this.stages.get(stage);
    return { ...summarize(b ? b.values() : []), last: b ? b.last() : NaN };
  }

  samples(stage) {
    return this.stages.get(stage)?.values() ?? new Float64Array();
  }

  /** Histogram with log-spaced bins between lo and hi (ms). */
  histogram(stage, bins = 24, lo = 0.001, hi = 1000) {
    const counts = new Array(bins).fill(0);
    const llo = Math.log10(lo);
    const span = Math.log10(hi) - llo;
    for (const v of this.samples(stage)) {
      const x = v <= lo ? 0 : (Math.log10(v) - llo) / span;
      counts[Math.min(bins - 1, Math.max(0, Math.floor(x * bins)))]++;
    }
    return counts;
  }

  reset() {
    this.stages.clear();
    this.messages.reset();
    this.bytes.reset();
    this.events.reset();
  }
}
