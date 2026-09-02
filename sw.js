/* ============================================================================
 * MealFast — sw.js (service worker: offline support + update strategy)
 * ----------------------------------------------------------------------------
 * Registered by app.js. Precaches the app shell so MealFast is LOCAL-FIRST:
 * it opens instantly from the cache and works with no internet at all. The
 * network is only ever used to refresh the cache in the background and for the
 * optional Google Drive backup — never on the critical path to opening the app.
 *
 * Strategy:
 *   • App shell + icons (same-origin GETs): CACHE-FIRST with background refresh
 *     (stale-while-revalidate). We answer from the cache immediately — so a dead
 *     or missing connection can never stall the launch — and, when online, fetch
 *     a fresh copy in the background and store it for next time. That means a new
 *     deploy shows up on the *next* open after you've been online once (the
 *     version tag next to the MealFast wordmark tells you which build you're on).
 *   • Cross-origin (e.g. the Google sign-in script): passed straight through to
 *     the network, untouched. It's optional and guarded, so failing offline is
 *     harmless.
 * Bump CACHE_NAME on every deploy: the new worker installs the new cache and the
 * activate handler deletes the old one. (This is the "vNN" you increment.)
 * ==========================================================================*/
const CACHE_NAME = "mealfast-v73";
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

// Precache the shell. allSettled (not addAll) so one unreachable asset can't
// abort the whole precache and leave the app unable to open offline.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.allSettled(ASSETS.map((u) => cache.add(u))))
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

// Cache-first with background refresh (stale-while-revalidate) for same-origin
// GETs. The cached copy is returned straight away (works fully offline); in
// parallel, when online, we refetch and update the cache for the next open.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // let cross-origin (GSI, Drive) pass through

  event.respondWith((async () => {
    const cached = await caches.match(req);

    const fetchAndUpdate = fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(fetchAndUpdate);   // refresh in the background, don't block
      return cached;
    }
    // Not cached yet — go to the network, and fall back to the app shell for
    // navigations if we're offline.
    const net = await fetchAndUpdate;
    if (net) return net;
    if (req.mode === "navigate") {
      return (await caches.match("./index.html")) || (await caches.match("./")) || Response.error();
    }
    return Response.error();
  })());
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
