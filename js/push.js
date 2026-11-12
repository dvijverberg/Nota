// Pushmeldingen: service worker registreren, abonnement aan/uit per
// apparaat, testmelding. De server (edge function "push") stuurt elke
// minuut de herinneringen die aan de beurt zijn.

import { sb, SUPABASE_URL, SUPABASE_ANON_KEY } from "./store.js";

const PUSH_URL = `${SUPABASE_URL}/functions/v1/push`;

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// ---------- Service worker ----------
let regPromise = null;
export function registerServiceWorker({ onOpen } = {}) {
  if (!("serviceWorker" in navigator)) return null;
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register("sw.js").catch((e) => {
      console.warn("Service worker registreren mislukt:", e);
      regPromise = null;
      return null;
    });
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.type === "open" && typeof d.url === "string" && onOpen) onOpen(d.url);
    });
  }
  return regPromise;
}

async function registration() {
  const reg = (await registerServiceWorker()) || (await navigator.serviceWorker.getRegistration());
  if (!reg) throw new Error("de service worker kon niet starten");
  if (reg.active) return reg;
  // Wachten tot hij actief is (eerste keer), maar niet eindeloos.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error("de service worker start niet")), 10000)),
  ]);
}

async function currentSubscription() {
  if (!supported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch { return null; }
}

// ---------- Status ----------
// status: on | off | denied | unsupported | ios-install
let last = null;
export function cachedPushStatus() { return last; }

export async function pushStatus() {
  if (isIOS() && !isStandalone()) return (last = "ios-install");
  if (!supported()) return (last = "unsupported");
  if (Notification.permission === "denied") return (last = "denied");
  const sub = Notification.permission === "granted" ? await currentSubscription() : null;
  return (last = sub ? "on" : "off");
}

// ---------- Server ----------
function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function call(method, { auth = false, body } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  if (auth) {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("je bent niet ingelogd");
    headers.Authorization = `Bearer ${token}`;
  }
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(PUSH_URL, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("geen verbinding met de server");
  }
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) throw new Error((json && (json.error || json.message)) || `serverfout ${res.status}`);
  return json || {};
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert({
    endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, user_agent: navigator.userAgent,
  }, { onConflict: "endpoint" });
  if (error) throw new Error(error.message || "opslaan mislukt");
}

function sameKey(sub, key) {
  const k = sub.options && sub.options.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  return a.length === key.length && a.every((x, i) => x === key[i]);
}

// ---------- Acties ----------
// Moet direct vanuit een tik worden aangeroepen: requestPermission() eerst.
export async function enablePush() {
  if (!supported()) throw new Error("deze browser ondersteunt geen meldingen");
  const perm = await Notification.requestPermission();
  if (perm === "denied") throw new Error("meldingen zijn geblokkeerd in je browserinstellingen");
  if (perm !== "granted") throw new Error("je gaf geen toestemming");
  const reg = await registration();
  const { publicKey } = await call("GET");
  if (!publicKey) throw new Error("de server gaf geen sleutel terug");
  const key = urlB64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (e) {
      throw new Error(e && e.message ? e.message : "de browser weigerde het abonnement");
    }
  }
  await saveSubscription(sub);
  last = "on";
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    const { error } = await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
    if (error) console.warn("Abonnement verwijderen mislukt:", error);
  }
  last = "off";
}

export async function sendTestPush() {
  const r = await call("POST", { auth: true, body: { test: true } });
  return Number(r.sent) || 0;
}

// Bij opstarten: abonnement opnieuw doorgeven (endpoints kunnen wisselen).
export async function resyncPush() {
  try {
    if (!supported() || Notification.permission !== "granted") return;
    const sub = await currentSubscription();
    if (sub) await saveSubscription(sub);
  } catch (e) {
    console.warn("Abonnement bijwerken mislukt:", e);
  }
}
