// kiwiboard — service worker.
// Jobs: (1) make the site installable as a PWA, (2) show the last-loaded page
// when offline, (3) display Web Push notifications.
//
// Deliberately conservative so it can't serve a stale dashboard:
// only same-origin page navigations are handled, network-first. API calls
// (workers.dev), CDN scripts and images are never intercepted or cached.
//
// Kill switch: if this ever misbehaves, replace this file with one whose
// activate handler calls `self.registration.unregister()` and redeploy.

const SHELL_CACHE = "pt-shell-v1";
const PRECACHE = ["/", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("pt-") && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok && url.pathname === "/") {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put("/", fresh.clone());
      }
      return fresh;
    } catch {
      return (await caches.match("/")) || Response.error();
    }
  })());
});

// ── Web Push ────────────────────────────────────────────────────────────────
// Payload (JSON, sent by the Worker): { title, body, url, tag }
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "kiwiboard", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag || "poortrader",
      renotify: Boolean(data.tag),
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        return "navigate" in w ? w.navigate(target) : undefined;
      }
    }
    return self.clients.openWindow(target);
  })());
});
