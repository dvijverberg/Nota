// Nota service worker: pushmeldingen tonen, tik op melding opent de taak,
// en de app-bestanden uit een eigen cache, zodat de app direct opstart,
// ook op een trage verbinding.
// Supabase en andere domeinen gaan altijd rechtstreeks naar het netwerk.
//
// Updates: de pagina stuurt na het opstarten "check". Dan halen we alle
// app-bestanden opnieuw op (conditioneel, dus meestal een snelle 304). Is
// er iets veranderd, dan komt alles samen in een nieuwe cache die pas
// in gebruik gaat als hij compleet is (nooit een mix van oude en nieuwe
// bestanden). De pagina herlaadt dan meteen als je net opstartte en nog
// niets deed, anders zie je de nieuwe versie bij de volgende start.
// Geen versienummer om op te hogen bij een deploy.

const SHELL = "nota-shell-";
const SCOPE = self.registration.scope; // bijv. https://.../nota/
const DONE = SCOPE + "__nota_complete";
const ICON = new URL("icons/icon-192.png", SCOPE).href;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Oude caches van eerdere versies van dit bestand (bijv. "nota-v1").
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("nota-") && !k.startsWith(SHELL)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---------- App-bestanden ----------
const ASSET = /\.(js|css|png|jpg|svg|ico|json|webmanifest|woff2?)$/i;
const inShell = (u) => u.startsWith(SCOPE) && (u.split(/[?#]/)[0] === SCOPE || ASSET.test(new URL(u).pathname));

// De nieuwste complete cache (met DONE-markering).
let current = null;
function currentCache() {
  if (!current) current = (async () => {
    const names = (await caches.keys()).filter((k) => k.startsWith(SHELL)).sort().reverse();
    for (const name of names) {
      const c = await caches.open(name);
      if (await c.match(DONE)) return { name, cache: c };
    }
    return null;
  })();
  return current;
}
async function ensureCache() {
  const cur = await currentCache();
  if (cur) return cur;
  const name = SHELL + Date.now();
  const cache = await caches.open(name);
  await cache.put(DONE, new Response("1"));
  current = Promise.resolve({ name, cache });
  return current;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  const nav = req.mode === "navigate";
  if (!nav && !ASSET.test(url.pathname)) return;
  e.respondWith(fromShell(req, nav));
});

async function fromShell(req, nav) {
  // Alle pagina-navigaties zijn dezelfde index.html: onder één sleutel bewaren.
  const key = nav ? SCOPE : req.url.split("#")[0];
  try {
    const cur = await currentCache();
    const hit = cur && await cur.cache.match(key, { ignoreSearch: nav });
    if (hit) return hit;
  } catch {}
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    ensureCache().then(({ cache }) => cache.put(key, copy)).catch(() => {});
  }
  return res;
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

let checking = null;
async function checkUpdate(extra) {
  const cur = await ensureCache();
  const known = (await cur.cache.keys()).map((r) => r.url).filter((u) => u !== DONE);
  const urls = [...new Set([SCOPE, ...known, ...extra.filter(inShell).map((u) => u.split("#")[0])])];
  const fresh = await Promise.all(urls.map(async (u) => {
    try { return [u, await fetch(u, { cache: "no-cache", credentials: "same-origin" })]; }
    catch { return [u, null]; }
  }));
  // Offline of halverwege mislukt: niets aanpassen.
  if (fresh.some(([, r]) => !r || (!r.ok && r.status !== 404))) return false;
  const good = fresh.filter(([, r]) => r.ok && r.type === "basic");
  const bodies = await Promise.all(good.map(async ([u, r]) => [u, r, await r.clone().arrayBuffer()]));
  let changed = false;
  const added = [];
  for (const [u, r, body] of bodies) {
    const old = await cur.cache.match(u);
    if (!old) { added.push([u, r]); continue; }
    if (!sameBytes(await old.arrayBuffer(), body)) { changed = true; break; }
  }
  if (!changed) {
    // Alleen nieuwe bestanden erbij (bijv. de eerste keer): gewoon toevoegen.
    await Promise.all(added.map(([u, r]) => cur.cache.put(u, r)));
    return false;
  }
  const name = SHELL + Date.now();
  const next = await caches.open(name);
  await Promise.all(bodies.map(([u, r]) => next.put(u, r)));
  await next.put(DONE, new Response("1"));
  current = Promise.resolve({ name, cache: next });
  const old = (await caches.keys()).filter((k) => k.startsWith(SHELL) && k !== name);
  await Promise.all(old.map((k) => caches.delete(k)));
  return true;
}

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type !== "check") return;
  e.waitUntil((async () => {
    if (!checking) checking = checkUpdate(Array.isArray(d.urls) ? d.urls : []).catch(() => false).finally(() => { checking = null; });
    const updated = await checking;
    if (updated && e.source) e.source.postMessage({ type: "updated" });
  })());
});

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
