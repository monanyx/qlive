/**
 * Number / time formatting helpers. Intl formatters are expensive to build,
 * so they are cached per (locale-independent) option set.
 */

const cache = new Map();
const nf = (min, max, extra = {}) => {
  const key = `${min}|${max}|${JSON.stringify(extra)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, ...extra });
    cache.set(key, f);
  }
  return f;
};

const DASH = '—';
const ok = (n) => typeof n === 'number' && Number.isFinite(n);

/** Price with a fixed number of decimals and thousands separators. */
export const fmtPrice = (n, decimals = 2) => (ok(n) ? nf(decimals, decimals).format(n) : DASH);

/** Base-asset size. */
export const fmtSize = (n, decimals = 4) => (ok(n) ? nf(decimals, decimals).format(n) : DASH);

/** Dollar amount, e.g. $12,345.67 */
export const fmtUsd = (n, decimals = 2) => {
  if (!ok(n)) return DASH;
  const s = nf(decimals, decimals).format(Math.abs(n));
  return `${n < 0 ? '−' : ''}$${s}`;
};

/** Signed dollar amount, e.g. +$12.30 / −$4.00 */
export const fmtUsdSigned = (n, decimals = 2) => {
  if (!ok(n)) return DASH;
  const s = nf(decimals, decimals).format(Math.abs(n));
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}$${s}`;
};

/** Compact notation: 1.2K, 3.45M, 6.7B */
export const fmtCompact = (n, digits = 2) => {
  if (!ok(n)) return DASH;
  const abs = Math.abs(n);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, u] of units) {
    if (abs >= v) return `${n < 0 ? '−' : ''}${nf(0, digits).format(abs / v)}${u}`;
  }
  return nf(0, digits).format(n);
};

/** Signed percent, e.g. +1.23% */
export const fmtPct = (n, decimals = 2) => {
  if (!ok(n)) return DASH;
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${nf(decimals, decimals).format(Math.abs(n))}%`;
};

/** Basis points, e.g. 1.6 bps */
export const fmtBps = (n, decimals = 1) => (ok(n) ? `${nf(decimals, decimals).format(n)} bps` : DASH);

/** Milliseconds with adaptive unit: µs below 1 ms, s above 10 s. */
export const fmtMs = (ms) => {
  if (!ok(ms)) return DASH;
  const a = Math.abs(ms);
  if (a < 1) return `${nf(0, 0).format(ms * 1000)} µs`;
  if (a < 10) return `${nf(2, 2).format(ms)} ms`;
  if (a < 10_000) return `${nf(0, 0).format(ms)} ms`;
  return `${nf(1, 1).format(ms / 1000)} s`;
};

export const fmtBytes = (n) => {
  if (!ok(n)) return DASH;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${nf(1, 1).format(n / 1024)} KB`;
  return `${nf(2, 2).format(n / 1024 / 1024)} MB`;
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** HH:MM:SS in local time. */
export const fmtTime = (ts) => {
  if (!ok(ts)) return DASH;
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** HH:MM:SS.mmm in local time. */
export const fmtTimeMs = (ts) => (ok(ts) ? `${fmtTime(ts)}.${pad(new Date(ts).getMilliseconds(), 3)}` : DASH);

/** YYYY-MM-DD HH:MM:SS local. */
export const fmtDateTime = (ts) => {
  if (!ok(ts)) return DASH;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ts)}`;
};

export const fmtUtcClock = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
};

/** "3s ago", "2m ago" */
export const fmtAgo = (ts, now = Date.now()) => {
  if (!ok(ts)) return DASH;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

/** Round to a step without accumulating binary float noise. */
export const roundTo = (n, step, mode = 'round') => {
  const d = Math.min(12, Math.max(0, -Math.floor(Math.log10(step)) + 2));
  const q = n / step;
  const r = mode === 'floor' ? Math.floor(q + 1e-9) : mode === 'ceil' ? Math.ceil(q - 1e-9) : Math.round(q);
  return Number((r * step).toFixed(d));
};

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
