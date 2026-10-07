/**
 * Namespaced, failure-tolerant localStorage wrapper.
 * Storage can be unavailable (private mode, disabled cookies, quota); every
 * call degrades to an in-memory fallback instead of throwing.
 */
const NS = 'qlive.';
const memory = new Map();

const backend = (() => {
  try {
    const ls = globalThis.localStorage;
    const probe = `${NS}__probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
})();

export const storage = {
  available: !!backend,

  get(key, fallback = null) {
    try {
      const raw = backend ? backend.getItem(NS + key) : memory.get(NS + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    const raw = JSON.stringify(value);
    try {
      if (backend) backend.setItem(NS + key, raw);
      else memory.set(NS + key, raw);
    } catch {
      memory.set(NS + key, raw);
    }
  },

  remove(key) {
    try {
      backend?.removeItem(NS + key);
    } catch {
      /* ignore */
    }
    memory.delete(NS + key);
  },
};

/** In-memory storage with the same interface — used by tests. */
export const createMemoryStorage = () => {
  const m = new Map();
  return {
    available: true,
    get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f),
    set: (k, v) => m.set(k, JSON.stringify(v)),
    remove: (k) => m.delete(k),
  };
};
