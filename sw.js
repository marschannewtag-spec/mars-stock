// sw.js — Service Worker:快取 App 殼層,讓 PWA 可離線開啟、可安裝。
const CACHE = 'signaldesk-v35';
const SHELL = [
  './', './index.html',
  './css/styles.css',
  './js/app.js', './js/config.js', './js/data.js', './js/data-real.js',
  './js/sectors.js', './js/strategy.js', './js/portfolio.js', './js/backtest.js',
  './js/market.js', './js/histdb.js', './js/indicators.js', './js/presets.js',
  './js/backtest-real.js',
  './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) { e.respondWith(fetch(e.request)); return; }
  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});
