/**
 * Frame scheduler: views mark themselves dirty when their data changes and
 * are repainted at most once per animation frame. This decouples message
 * rate (hundreds/s) from paint rate (≤ display refresh) — the single biggest
 * performance win over re-rendering on every message.
 *
 * Views can also declare a minimum interval (e.g. heavy canvases at 10 fps).
 */
export class Scheduler {
  constructor({ latency = null } = {}) {
    this.latency = latency;
    this.views = new Map();
    this.raf = 0;
    this.lastFrame = 0;
    this.fps = 0;
    this.frames = 0;
    this.fpsAt = performance.now();
    this.loop = this.loop.bind(this);
  }

  /** Register a render function. Returns a `mark()` function to flag it dirty. */
  add(name, render, { minInterval = 0 } = {}) {
    const view = { render, dirty: true, minInterval, last: 0 };
    this.views.set(name, view);
    this.#request();
    return () => {
      view.dirty = true;
      this.#request();
    };
  }

  mark(name) {
    const v = this.views.get(name);
    if (v) {
      v.dirty = true;
      this.#request();
    }
  }

  markAll() {
    for (const v of this.views.values()) v.dirty = true;
    this.#request();
  }

  #request() {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  loop(now) {
    this.raf = 0;
    // Only consecutive frames count as a frame interval (idle gaps don't).
    if (this.lastFrame && now - this.lastFrame < 250 && this.latency)
      this.latency.record('frame', now - this.lastFrame);
    this.lastFrame = now;
    this.frames++;
    if (now - this.fpsAt >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsAt);
      this.frames = 0;
      this.fpsAt = now;
    }

    const t0 = performance.now();
    let pending = false;
    for (const [name, v] of this.views) {
      if (!v.dirty) continue;
      if (v.minInterval && now - v.last < v.minInterval) {
        pending = true;
        continue;
      }
      v.dirty = false;
      v.last = now;
      try {
        v.render(now);
      } catch (err) {
        console.error(`[scheduler] view "${name}" failed`, err);
      }
    }
    const spent = performance.now() - t0;
    if (spent > 0 && this.latency) this.latency.record('render', spent);
    if (pending) this.#request();
  }
}
