// Nota service worker: pushmeldingen tonen, tik op melding opent de taak,
// en een eenvoudige offline-cache (eerst netwerk, anders de cache).
// Supabase en andere domeinen gaan altijd rechtstreeks naar het netwerk.

const CACHE = "nota-v1";
const SCOPE = self.registration.scope; // bijv. https://.../nota/
const ICON = new URL("icons/icon-192.png", SCOPE).href;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("nota-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---------- Offline ----------
const ASSET = /\.(js|css|png|jpg|svg|ico|json|webmanifest|woff2?)$/i;

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  const nav = req.mode === "navigate";
  if (!nav && !ASSET.test(url.pathname)) return;
  e.respondWith(networkFirst(req, nav));
});

async function networkFirst(req, nav) {
  // Alle pagina-navigaties zijn dezelfde index.html: onder één sleutel bewaren.
  const key = nav ? SCOPE : req;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(key, { ignoreSearch: nav });
    if (hit) return hit;
    throw err;
  }
}

// ---------- Meldingen ----------
self.addEventListener("push", (e) => {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch { d = null; }
  if (!d || typeof d !== "object") d = {};
  const title = d.title || "Nota";
  const opts = {
    body: d.body || (d.title ? "" : "Je hebt een herinnering."),
    data: { url: d.url || "", taskId: d.taskId || null },
    icon: ICON,
    badge: ICON,
  };
  // renotify mag alleen samen met een tag.
  if (d.tag) { opts.tag = String(d.tag); opts.renotify = true; }
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const rel = (e.notification.data && e.notification.data.url) || "";
  const target = new URL("./" + rel, SCOPE).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = list.find((c) => c.url.startsWith(SCOPE));
    if (client) {
      try { await client.focus(); } catch {}
      if (rel) client.postMessage({ type: "open", url: rel });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
