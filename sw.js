/* Ledgerly application-shell service worker.
 * Increase APP_VERSION whenever this file or the application shell changes.
 */
const APP_VERSION = "2026.07.31.2";
const SHELL_CACHE = `ledgerly-shell-${APP_VERSION}`;
const OFFLINE_URL = new URL("./offline.html", self.registration.scope).href;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./offline.html",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/favicon-32.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("ledgerly-shell-") && name !== SHELL_CACHE)
            .map((name) => caches.delete(name))
        )
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept Supabase, receipt, authentication, CDN, or any other
  // cross-origin request. Financial data must always use the network and the
  // authenticated Supabase client rather than the public application cache.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // config.js can change independently and contains environment-specific
  // connection settings. Prefer the network and use a cached copy only when a
  // temporary network failure occurs after the app has already been installed.
  if (url.pathname.endsWith("/config.js")) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (["script", "style", "image", "font", "manifest"].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(new URL("./index.html", self.registration.scope), response.clone());
    }
    return response;
  } catch {
    // A fresh offline launch shows a clear status page instead of exposing
    // stale financial information or pretending cloud synchronization works.
    return (await caches.match(OFFLINE_URL)) || Response.error();
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request, { ignoreSearch: true })) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const networkResponse = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await networkResponse) || Response.error();
}
