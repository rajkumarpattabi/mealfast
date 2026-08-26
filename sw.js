/* ============================================================================
 * MealFast — sw.js (service worker: offline support + update strategy)
 * ----------------------------------------------------------------------------
 * Registered by app.js. Precaches the app shell so MealFast opens with no
 * network, and controls how updates reach the device:
 *   • App shell (html/css/js/json/md): NETWORK-FIRST — fetch the latest when
 *     online, fall back to cache when offline. This is why a fresh deploy shows
 *     up on next open once you're online.
 *   • Everything else (icons): CACHE-FIRST — rarely changes.
 * Bump CACHE_NAME on every deploy: the new worker installs the new cache and
 * the activate handler deletes the old one. (This is the "vNN" you increment.)
 * ==========================================================================*/
const CACHE_NAME = "mealfast-v66";
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

// Tapping a stage/goal notification: focus the app if it's already open,
// otherwise open it. (Notifications themselves are shown from app.js via
// registration.showNotification — the iOS-supported path.)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./index.html");
    })
  );
});
