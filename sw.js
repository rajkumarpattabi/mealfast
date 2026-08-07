const CACHE_NAME = "mealfast-v46";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./README.md",
  "./manifest.json",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell (HTML/CSS/JS/manifest) so a new deploy shows up
// as soon as you're online; fall back to the cached copy only when offline.
// Icons and everything else stay cache-first (they rarely change).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isShell =
    req.mode === "navigate" ||
    (url.origin === self.location.origin && /\.(?:html|css|js|json|md)$/.test(url.pathname));

  if (isShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
  } else {
    event.respondWith(caches.match(req).then((c) => c || fetch(req)));
  }
});
