/* Installable PWA. Network first, the cache only when offline. Sensitive URLs (/api, ?enroll=, /android) are never cached. */
const SHELL = "csa-shell-v3";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/"]))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/android/") ||
    url.searchParams.has("enroll")
  ) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request)));
});
