/**
 * Minimal synchronous event emitter.
 * Listeners are called in registration order; errors in one listener never
 * prevent the others from running.
 */
export class Emitter {
  #listeners = new Map();

  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter] listener for "${type}" failed`, err);
      }
    }
  }

  removeAll() {
    this.#listeners.clear();
  }
}
