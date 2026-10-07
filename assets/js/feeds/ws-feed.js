/**
 * Base class for WebSocket market-data feeds.
 *
 * Handles the connection lifecycle that every venue needs:
 *  • connect timeout, exponential backoff with jitter on reconnect
 *  • alternate endpoints (cycled on each attempt)
 *  • stale-stream detection (no message for `staleMs` → reconnect)
 *  • per-message instrumentation (bytes, parse time)
 *
 * Subclasses implement `urls()`, `subscriptions()` and `normalize(msg, recv)`.
 *
 * Status states: connecting → open → live, then reconnecting / error / closed.
 */
export class WsFeed {
  constructor({ symbol, onEvent = () => {}, onStatus = () => {}, latency = null, staleMs = 15_000 }) {
    this.symbol = symbol;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.latency = latency;
    this.staleMs = staleMs;
    this.ws = null;
    this.attempt = 0;
    this.stopped = true;
    this.live = false;
    this.lastMessageAt = 0;
    this.timers = new Set();
  }

  /** Endpoint URLs to try, in order of preference. */
  urls() {
    return [];
  }

  /** Messages to send once the socket opens. */
  subscriptions() {
    return [];
  }

  /** Convert one decoded message to normalised events. */
  normalize() {
    return [];
  }

  /** Events that prove market data is flowing (the 'live' state). */
  isMarketData(ev) {
    return ev.type === 'book' || ev.type === 'trade';
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.#clearTimers();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try {
        this.ws.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.onStatus({ state: 'closed' });
  }

  /** Drop the connection and resubscribe (e.g. to get a fresh book snapshot). */
  resync(reason = 'resync') {
    if (this.stopped) return;
    this.onStatus({ state: 'reconnecting', detail: reason, attempt: 0 });
    this.#teardownSocket();
    this.#connect();
  }

  #later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  #clearTimers() {
    for (const id of this.timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    this.timers.clear();
  }

  #teardownSocket() {
    this.#clearTimers();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  #connect() {
    const urls = this.urls();
    const url = urls[this.attempt % urls.length];
    this.live = false;
    this.onStatus({ state: 'connecting', detail: new URL(url).host, attempt: this.attempt });

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onStatus({ state: 'error', detail: err.message });
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    const openTimer = this.#later(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.onStatus({ state: 'error', detail: 'Connection timed out' });
        this.#teardownSocket();
        this.#scheduleReconnect();
      }
    }, 10_000);

    ws.onopen = () => {
      clearTimeout(openTimer);
      this.timers.delete(openTimer);
      this.onStatus({ state: 'open', detail: new URL(url).host });
      for (const sub of this.subscriptions()) ws.send(JSON.stringify(sub));
      this.lastMessageAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - this.lastMessageAt > this.staleMs) {
          this.onStatus({ state: 'reconnecting', detail: 'Stream went quiet', attempt: this.attempt });
          this.#teardownSocket();
          this.#scheduleReconnect();
        }
      }, 2500);
      this.timers.add(watchdog);
    };

    ws.onmessage = (e) => {
      const recv = Date.now();
      this.lastMessageAt = recv;
      const raw = e.data;
      const t0 = performance.now();
      let events;
      try {
        events = this.normalize(JSON.parse(raw), recv);
      } catch (err) {
        console.warn(`[${this.constructor.name}] bad message`, err);
        return;
      }
      if (this.latency) {
        this.latency.record('parse', performance.now() - t0);
        this.latency.message(typeof raw === 'string' ? raw.length : (raw.byteLength ?? 0), recv);
      }
      for (const ev of events) {
        if (!this.live && this.isMarketData(ev)) {
          this.live = true;
          this.attempt = 0;
          this.onStatus({ state: 'live' });
        }
        this.onEvent(ev);
      }
    };

    ws.onerror = () => {
      // The close handler that always follows does the reconnecting.
      this.onStatus({ state: 'error', detail: 'WebSocket error' });
    };

    ws.onclose = (e) => {
      if (this.stopped) return;
      this.#teardownSocket();
      this.onStatus({ state: 'reconnecting', detail: e.code ? `Closed (${e.code})` : 'Closed', attempt: this.attempt });
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    this.attempt++;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    const delay = base * (0.6 + Math.random() * 0.4);
    this.onStatus({ state: 'reconnecting', detail: `Retrying in ${Math.round(delay / 1000)}s`, attempt: this.attempt });
    this.#later(() => this.#connect(), delay);
  }
}
