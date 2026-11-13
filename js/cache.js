// Laatst geladen gegevens op het toestel bewaren, zodat de app bij het
// opstarten meteen iets kan tonen en daarna op de achtergrond vernieuwt.
// Per gebruiker (sleutel met user-id) en bij uitloggen gewist. Alleen een
// gemak: lukt lezen of schrijven niet, dan laadt de app gewoon zoals altijd.

import { state, subscribe, audioUrls } from "./store.js";

const PREFIX = "nota-cache:";
const VERSION = 1;
const MAX_AGE = 14 * 864e5; // ouder dan twee weken: niet meer tonen

let userId = null;
let timer = 0;

function key(id) { return PREFIX + id; }

// Leest de snapshot en zet hem in state. true als dat lukte.
export function hydrate(id) {
  if (!id) return false;
  let snap;
  try { snap = JSON.parse(localStorage.getItem(key(id)) || "null"); } catch { snap = null; }
  if (!snap || snap.v !== VERSION || snap.user !== id || Date.now() - snap.at > MAX_AGE) return false;
  const now = Date.now();
  for (const [p, u] of snap.audioUrls || []) if (u && now - u.at < 50 * 60 * 1000) audioUrls.set(p, u);
  state.projects = snap.projects || [];
  state.sections = snap.sections || [];
  state.labels = snap.labels || [];
  state.filters = snap.filters || [];
  state.tasks = new Map((snap.tasks || []).map((t) => [t.id, t]));
  state.notes = (snap.notes || []).map((n) => {
    const u = n.audio_path ? audioUrls.get(n.audio_path) : null;
    return { ...n, audioUrl: u ? u.url : null };
  });
  state.settings = snap.settings || state.settings;
  state.loaded = true;
  return true;
}

function save() {
  timer = 0;
  dirty = false;
  if (!userId || !state.loaded) return;
  const since = state.completedSince && state.completedSince !== "0000" ? state.completedSince : null;
  const snap = {
    v: VERSION, user: userId, at: Date.now(),
    projects: state.projects, sections: state.sections, labels: state.labels, filters: state.filters,
    // Oudere voltooide taken (via "Oudere laden") niet bewaren.
    tasks: [...state.tasks.values()].filter((t) => !t.completed || t.note_id || !since || String(t.completed_at) >= since),
    notes: state.notes.map(({ audioUrl, ...n }) => n),
    audioUrls: [...audioUrls],
    settings: state.settings,
  };
  try { localStorage.setItem(key(userId), JSON.stringify(snap)); }
  catch { try { localStorage.removeItem(key(userId)); } catch {} }
}

// Na vernieuwen (even rustig moment) en bij het verlaten van de app
// bewaren; niet bij elke wijziging, zodat typen en tikken er geen last van
// hebben.
let dirty = false;
export function saveSoon() { schedule(); }
document.addEventListener("visibilitychange", () => { if (document.hidden && dirty) { clearTimeout(timer); save(); } });
addEventListener("pagehide", () => { if (dirty) save(); });

function schedule() {
  if (timer || !userId) return;
  // Niet tijdens een interactie: pas als de browser even niets doet.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  timer = setTimeout(() => idle(save, { timeout: 3000 }), 1500);
}

// Begin met bewaren voor deze gebruiker (na inloggen / opstarten).
export function startCaching(id) {
  userId = id || null;
}

subscribe((kinds) => { if (!kinds || kinds.has("data")) dirty = true; });

// Uitloggen: alles van het toestel halen.
export function clearCache() {
  userId = null;
  clearTimeout(timer);
  timer = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {}
}
