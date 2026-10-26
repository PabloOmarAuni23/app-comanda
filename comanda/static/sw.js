const CACHE_NAME = "comanda-shell-v47";
const APP_SHELL = ["/static/production.js?v=45", "/static/production.css?v=46", "/", "/static/style.css?v=47", "/static/kiosk.css?v=47", "/static/app.js?v=47", "/static/pickup.js?v=45", "/static/alerts.js?v=45", "/static/icon.svg", "/static/icon-192.png", "/static/icon-512.png", "/static/apple-touch-icon.png", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
