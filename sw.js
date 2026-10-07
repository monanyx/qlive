/*
 * QuantumLive service worker — network-first with offline fallback.
 *
 * Online, every request goes to the network (so a deploy is picked up
 * immediately) and successful responses refresh the cache. Offline, cached
 * files are served; the terminal then runs on the built-in simulator.
 * Exchange APIs and WebSockets are never intercepted.
 *
 * Bump VERSION when the precache list changes (tests/site.test.js checks it
 * against the files on disk).
 */
const VERSION = 'qlive-v2.0.0';
const PRECACHE = [
  './',
  '404.html',
  'docs.html',
  'favicon.svg',
  'index.html',
  'manifest.webmanifest',
  'markets.html',
  'terminal.html',
  'assets/css/base.css',
  'assets/css/site.css',
  'assets/css/terminal.css',
  'assets/fonts/inter-latin-var.woff2',
  'assets/fonts/jetbrains-mono-latin-var.woff2',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/img/icons.svg',
  'assets/js/boot.js',
  'vendor/lightweight-charts/lightweight-charts.mjs',
  'assets/js/core/config.js',
  'assets/js/core/emitter.js',
  'assets/js/core/format.js',
  'assets/js/core/rng.js',
  'assets/js/core/storage.js',
  'assets/js/feeds/exchanges.js',
  'assets/js/feeds/history.js',
  'assets/js/feeds/manager.js',
  'assets/js/feeds/multi-ticker.js',
  'assets/js/feeds/normalize.js',
  'assets/js/feeds/sim-feed.js',
  'assets/js/feeds/ws-feed.js',
  'assets/js/market/candles.js',
  'assets/js/market/market.js',
  'assets/js/market/orderbook.js',
  'assets/js/metrics/latency.js',
  'assets/js/pages/docs.js',
  'assets/js/pages/landing.js',
  'assets/js/pages/markets.js',
  'assets/js/pages/terminal.js',
  'assets/js/sim/market-sim.js',
  'assets/js/trading/alerts.js',
  'assets/js/trading/paper-engine.js',
  'assets/js/ui/account-view.js',
  'assets/js/ui/candle-chart.js',
  'assets/js/ui/depth-chart.js',
  'assets/js/ui/diagnostics-view.js',
  'assets/js/ui/dom.js',
  'assets/js/ui/heatmap.js',
  'assets/js/ui/order-form.js',
  'assets/js/ui/orderbook-view.js',
  'assets/js/ui/scheduler.js',
  'assets/js/ui/site.js',
  'assets/js/ui/sound.js',
  'assets/js/ui/sparkline.js',
  'assets/js/ui/theme.js',
  'assets/js/ui/toast.js',
  'assets/js/ui/trade-tape.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const response = await Promise.race([fetch(request), timeout(6000)]);
        // Key by path so query strings (deep links) don't multiply entries.
        if (response.ok && response.type === 'basic') cache.put(url.origin + url.pathname, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return (await cache.match('404.html')) ?? Response.error();
        return Response.error();
      }
    })(),
  );
});
