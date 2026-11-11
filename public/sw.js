// Service worker: offline fallback page, push notifications, and opening the app from a notification.
//
// Caching is deliberately minimal. Pages contain personal data and are never cached: when offline,
// a navigation shows /offline.html. Static files (CSS, JS, icons) are network-first: always the deployed
// version, so new HTML never meets old CSS after a deploy. The cache is only the offline fallback.

const CACHE = "static-v2";
const PRECACHE = [
  "/offline.html",
  "/app.css",
  "/app.js",
  "/training-chart.js",
  "/vendor/htmx.min.js",
  "/icons/logo.svg",
  "/icons/icon-192.png",
  "/icons/badge-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) => /^\/(vendor|icons|brand)\//.test(url.pathname) || /\.(css|js|svg|png|webmanifest)$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  if (isStatic(url) && url.pathname !== "/sw.js") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? Response.error()),
    );
  }
});

// --- Push ----------------------------------------------------------------------------------------
// The server sends JSON: { title, body, url, tag } (see src/push/notify.ts).

self.addEventListener("push", (event) => {
  let message = { title: "New update", body: "", url: "/" };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    // not JSON: show the defaults
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: message.tag,
      data: { url: message.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only ever open pages of this app.
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        return existing.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// Some browsers rotate a subscription on their own: tell the server about the new one.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription?.options;
      if (!options) return;
      const subscription = await self.registration.pushManager.subscribe(options);
      await fetch("/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
        credentials: "same-origin",
      });
    })(),
  );
});
