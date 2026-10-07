/**
 * Seedable pseudo-random number generation for the simulator.
 * mulberry32 is tiny, fast and statistically good enough for visual market
 * simulation; seeding makes simulator runs and unit tests reproducible.
 */
export function createRng(seed = Date.now()) {
  let s = seed >>> 0;
  let spare = null;

  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Standard normal via the Marsaglia polar method (caches the spare). */
  const normal = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u, v, q;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      q = u * u + v * v;
    } while (q >= 1 || q === 0);
    const f = Math.sqrt((-2 * Math.log(q)) / q);
    spare = v * f;
    return u * f;
  };

  return {
    next,
    normal,
    /** Uniform float in [a, b). */
    uniform: (a = 0, b = 1) => a + (b - a) * next(),
    /** Exponential with the given mean. */
    exponential: (mean) => -mean * Math.log(1 - next()),
    /** Lognormal with E[ln X] = mu and sd[ln X] = sigma. */
    lognormal: (mu, sigma) => Math.exp(mu + sigma * normal()),
    /** Pareto (type I) with scale xm and shape alpha — heavy tailed. */
    pareto: (xm, alpha) => xm / Math.pow(1 - next(), 1 / alpha),
    /** Poisson sample (Knuth for small lambda, normal approx for large). */
    poisson: (lambda) => {
      if (lambda <= 0) return 0;
      if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()));
      const L = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > L);
      return k - 1;
    },
    bernoulli: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
