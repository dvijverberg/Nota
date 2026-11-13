// Datalaag: alles uit Supabase in het geheugen (één gebruiker, weinig
// data), wijzigingen optimistisch toepassen en bij een fout terugdraaien.

import { toast, uuid } from "./ui.js";

export const SUPABASE_URL = "https://rqhrtiexwmgrlzgvrigm.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_GQKT1FiA-eudNrKfOY7jcQ_NMrWQQ8Y";
// "sb" i.p.v. "supabase": de library claimt die naam al als globale.
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Zelfde kleuren/categorieën als server/app.py (LABEL_COLORS,
// TODO_CATEGORIES), zodat beide interfaces gelijk ogen.
export const LABEL_COLORS = {
  persoonlijk: "#9333ea",
  werk: "#ea580c",
  sport: "#16a34a",
  reizen: "#0d9488",
};
export const DEFAULT_LABEL_COLOR = "#7a726c";
export const TODO_CATEGORIES = ["persoonlijk", "werk", "sport", "reizen"];
export const CATEGORY_NAMES = {
  persoonlijk: "Persoonlijk",
  werk: "Werk",
  sport: "Sport",
  reizen: "Reizen",
};
export function labelColor(label) { return LABEL_COLORS[label] || DEFAULT_LABEL_COLOR; }
export function labelName(label) { return label ? (CATEGORY_NAMES[label] || label.charAt(0).toUpperCase() + label.slice(1)) : "Geen label"; }

// Kleuren voor projecten, labels en filters (zoals in Todoist).
export const COLORS = [
  { hex: "#B8255F", name: "Framboos" },
  { hex: "#DC4C3E", name: "Rood" },
  { hex: "#C77100", name: "Oranje" },
  { hex: "#B29104", name: "Geel" },
  { hex: "#65A33A", name: "Limoen" },
  { hex: "#369307", name: "Groen" },
  { hex: "#148FAD", name: "Petrol" },
  { hex: "#319DFF", name: "Hemelsblauw" },
  { hex: "#4180FF", name: "Blauw" },
  { hex: "#692EC2", name: "Druif" },
  { hex: "#E05095", name: "Magenta" },
  { hex: "#808080", name: "Grijs" },
];
export const DEFAULT_COLOR = "#808080";

export const state = {
  user: null,
  projects: [],
  sections: [],
  labels: [],
  filters: [],
  tasks: new Map(),
  notes: [],
  recordings: [],
  // Instellingen per account (tabel user_settings). Geen rij = standaard.
  settings: null,
  // Rij "pc" uit server_status: undefined = (nog) onbekend, null = geen rij.
  pcStatus: undefined,
  loaded: false,
  // Voltooide taken ouder dan 30 dagen laden we pas in "Voltooid".
  completedSince: null,
  allCompletedLoaded: false,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let emitQueued = false;
let emitKinds = new Set();
// Telt elke emit(); opzoektabellen (zoals childIndex) vervallen dan.
let rev = 0;
// Bundelt meerdere wijzigingen in één render. Luisteraars krijgen mee wat
// er veranderde: "data" (taken, projecten, ...) of "status" (alleen
// opnames/pc-status), zodat een view zonder status niet hoeft te renderen.
export function emit(kind = "data") {
  rev++;
  emitKinds.add(kind);
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    const kinds = emitKinds;
    emitKinds = new Set();
    listeners.forEach((fn) => { try { fn(kinds); } catch (e) { console.warn(e); } });
  });
}

// ---------- Lopende schrijfacties ----------
// Zolang een wijziging onderweg is (of tijdens een loadAll() gedaan is),
// mag het antwoord van die loadAll() de lokale versie niet overschrijven.
const inflight = new Map(); // id -> aantal lopende writes
let loadGuard = null;       // ids aangeraakt tijdens de lopende loadAll()
async function tracked(ids, req) {
  for (const id of ids) {
    inflight.set(id, (inflight.get(id) || 0) + 1);
    if (loadGuard) loadGuard.add(id);
  }
  try { return await req; }
  finally {
    for (const id of ids) {
      const n = (inflight.get(id) || 1) - 1;
      if (n) inflight.set(id, n); else inflight.delete(id);
    }
  }
}
export function hasPendingWrites() { return inflight.size > 0; }

// Verse rijen uit de database, maar met de lokale versie voor ids in guard.
function mergeRows(fresh, local, guard) {
  if (!guard.size) return fresh;
  const byId = new Map(local.map((x) => [x.id, x]));
  const out = fresh.filter((x) => !guard.has(x.id) || byId.has(x.id)).map((x) => (guard.has(x.id) ? byId.get(x.id) : x));
  const seen = new Set(out.map((x) => x.id));
  for (const id of guard) if (byId.has(id) && !seen.has(id)) out.push(byId.get(id));
  return out;
}

// Ondertekende audio-links (1 uur geldig) per pad, zodat vernieuwen niet
// steeds opnieuw hoeft te ondertekenen en de eerste weergave niet wacht.
export const audioUrls = new Map(); // audio_path -> { url, at }
const URL_TTL = 50 * 60 * 1000;

function fail(error, what = "Opslaan") {
  console.warn(what + " mislukt:", error);
  toast(`${what} mislukt. Probeer het opnieuw.`);
}

// ---------- Opzoeken ----------
export const byOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
  String(a.created_at || "").localeCompare(String(b.created_at || ""));

export function allTasks() { return [...state.tasks.values()]; }
export function openTasks() { return allTasks().filter((t) => !t.completed); }
export function getTask(id) { return state.tasks.get(id); }
export function projectById(id) { return state.projects.find((p) => p.id === id) || null; }
export function sectionById(id) { return state.sections.find((s) => s.id === id) || null; }
export function filterById(id) { return state.filters.find((f) => f.id === id) || null; }
export function labelByName(name) {
  const n = String(name || "").toLowerCase();
  return state.labels.find((l) => l.name.toLowerCase() === n) || null;
}
export function projectsById() {
  const m = {};
  state.projects.forEach((p) => { m[p.id] = p; });
  return m;
}
export function activeProjects() {
  return state.projects.filter((p) => !p.archived).sort((a, b) =>
    (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || byOrder(a, b));
}
export function sectionsOf(projectId) {
  return state.sections.filter((s) => s.project_id === projectId).sort(byOrder);
}
// Subtaken per ouder, één keer opgebouwd per wijziging (emit) i.p.v. per
// taakrij door alle taken te lopen. Na een wijziging dus altijd emit().
let kidsMap = null, kidsRev = -1, kidsOf = null;
function childIndex() {
  if (kidsRev === rev && kidsOf === state.tasks) return kidsMap;
  kidsMap = new Map();
  for (const t of state.tasks.values()) {
    if (!t.parent_id) continue;
    const l = kidsMap.get(t.parent_id);
    if (l) l.push(t); else kidsMap.set(t.parent_id, [t]);
  }
  for (const l of kidsMap.values()) l.sort(byOrder);
  kidsRev = rev; kidsOf = state.tasks;
  return kidsMap;
}
export function childrenOf(taskId, { includeCompleted = true } = {}) {
  const l = childIndex().get(taskId) || [];
  return includeCompleted ? l.slice() : l.filter((t) => !t.completed);
}
export function noteById(id) { return state.notes.find((n) => String(n.id) === String(id)) || null; }
export function tasksForNote(noteId) {
  return allTasks().filter((t) => String(t.note_id) === String(noteId))
    .sort((a, b) => (a.note_item_index ?? 0) - (b.note_item_index ?? 0));
}
export function openCount(pred) { return openTasks().filter(pred).length; }

// ---------- Laden ----------
function normalizeActionItems(raw) {
  // Zelfde normalisatie als server/app.py's normalize_action_items().
  let items;
  try { items = raw ? JSON.parse(raw) : []; } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.map((item) => typeof item === "string"
    ? { text: item, done: false }
    : { text: item.text || "", done: !!item.done });
}

function normTask(t) {
  if (t.due_time && t.due_time.length > 5) t.due_time = t.due_time.slice(0, 5);
  if (!Array.isArray(t.labels)) t.labels = [];
  if (typeof t.recurrence === "string") { try { t.recurrence = JSON.parse(t.recurrence); } catch { t.recurrence = null; } }
  return t;
}

let loading = null;
export function loadAll() {
  if (loading) return loading;
  loading = (async () => {
    const guard = new Set(inflight.keys());
    loadGuard = guard;
    try {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const [p, s, l, f, open, done, noteDone, n, us] = await Promise.all([
        sb.from("projects").select("*").order("sort_order", { ascending: true }),
        sb.from("sections").select("*").order("sort_order", { ascending: true }),
        sb.from("labels").select("*").order("sort_order", { ascending: true }),
        sb.from("filters").select("*").order("sort_order", { ascending: true }),
        sb.from("tasks").select("*").eq("completed", false),
        sb.from("tasks").select("*").eq("completed", true).gte("completed_at", since),
        // Afgevinkte actiepunten van notities, ook als ze ouder zijn, zodat
        // een notitie altijd al haar actiepunten laat zien.
        sb.from("tasks").select("*").eq("completed", true).not("note_id", "is", null),
        sb.from("notes").select("*").order("id", { ascending: false }),
        // Instellingen zijn niet nodig om de app te tonen: een fout hier
        // (bijv. tabel nog niet aangemaakt) houdt het laden niet tegen.
        sb.from("user_settings").select("*").maybeSingle(),
      ]);
      const err = [p, s, l, f, open, done, noteDone, n].find((r) => r.error);
      if (err) return { error: err.error };

      state.projects = mergeRows(p.data || [], state.projects, guard);
      state.sections = mergeRows(s.data || [], state.sections, guard);
      state.labels = mergeRows(l.data || [], state.labels, guard);
      state.filters = mergeRows(f.data || [], state.filters, guard);
      const tasks = new Map();
      for (const t of [...(open.data || []), ...(done.data || []), ...(noteDone.data || [])]) tasks.set(t.id, normTask(t));
      // Wat lokaal net gewijzigd/aangemaakt/verwijderd is, gaat voor.
      for (const id of guard) {
        if (id === "settings") continue;
        const local = state.tasks.get(id);
        if (local) tasks.set(id, local);
        else tasks.delete(id);
      }
      // Al eerder geladen oudere voltooide taken bewaren.
      if (state.allCompletedLoaded || state.completedSince) {
        for (const t of state.tasks.values()) if (t.completed && !tasks.has(t.id) && t.completed_at < since) tasks.set(t.id, t);
      } else {
        state.completedSince = since;
      }
      state.tasks = tasks;

      const notes = n.data || [];
      // Nog geldige audio-links hergebruiken; de rest wordt hieronder
      // ondertekend zonder dat de eerste weergave daarop wacht.
      const now = Date.now();
      const missing = [];
      for (const note of notes) {
        const u = note.audio_path ? audioUrls.get(note.audio_path) : null;
        note.audioUrl = u && now - u.at < URL_TTL ? u.url : null;
        if (note.audio_path && !note.audioUrl) missing.push(note.audio_path);
        note.actionItems = normalizeActionItems(note.action_items);
      }
      state.notes = notes;
      if (!guard.has("settings")) {
        if (!us.error) state.settings = normSettings(us.data);
        else if (!state.settings) state.settings = normSettings(null);
      }
      state.loaded = true;
      emit();
      if (missing.length) signAudio(notes, missing);
      return { error: null };
    } finally {
      loading = null;
      if (loadGuard === guard) loadGuard = null;
    }
  })();
  return loading;
}

// Alle ontbrekende audio-links in één keer ophalen i.p.v. per notitie.
async function signAudio(notes, paths) {
  let signed = null;
  try { ({ data: signed } = await sb.storage.from("audio").createSignedUrls(paths, 3600)); } catch { return; }
  const at = Date.now();
  (signed || []).forEach((x) => { if (x.signedUrl) audioUrls.set(x.path, { url: x.signedUrl, at }); });
  if (state.notes !== notes) return; // intussen opnieuw geladen
  for (const note of notes) {
    const u = audioUrls.get(note.audio_path);
    if (u && !note.audioUrl) note.audioUrl = u.url;
  }
  // Nieuwe lijst, zodat Notities de spelers opnieuw opbouwt.
  state.notes = notes.slice();
  emit();
}

// Oudere voltooide taken, per blok.
export async function loadOlderCompleted() {
  const before = state.completedSince || new Date().toISOString();
  const { data, error } = await sb.from("tasks").select("*").eq("completed", true)
    .lt("completed_at", before).order("completed_at", { ascending: false }).limit(100);
  if (error) { fail(error, "Laden"); return; }
  (data || []).forEach((t) => state.tasks.set(t.id, normTask(t)));
  if (!data || data.length < 100) state.allCompletedLoaded = true;
  else state.completedSince = data[data.length - 1].completed_at;
  if (state.allCompletedLoaded) state.completedSince = "0000";
  emit();
}

// ---------- Taken ----------
export function nextSortOrder(list) {
  return list.length ? Math.max(...list.map((t) => t.sort_order ?? 0)) + 1 : 1;
}

export function siblingsOf(t) {
  return openTasks().filter((x) => x.id !== t.id &&
    (x.project_id || null) === (t.project_id || null) &&
    (x.section_id || null) === (t.section_id || null) &&
    (x.parent_id || null) === (t.parent_id || null));
}

export async function createTask(fields) {
  const now = new Date().toISOString();
  const t = normTask({
    id: uuid(),
    project_id: null, section_id: null, parent_id: null,
    title: "", description: "", priority: 4,
    due_date: null, due_time: null, deadline: null, duration_min: null,
    recurrence: null, labels: [], reminder_at: null,
    completed: false, completed_at: null, note_id: null, note_item_index: null,
    created_at: now, updated_at: now,
    ...fields,
  });
  if (t.sort_order == null) t.sort_order = nextSortOrder(siblingsOf(t));
  state.tasks.set(t.id, t);
  emit();
  const row = { ...t };
  // Door de server beheerd: nooit zelf meesturen.
  delete row.created_at; delete row.updated_at; delete row.reminder_sent_for;
  const { error } = await tracked([t.id], sb.from("tasks").insert(row));
  if (error) { state.tasks.delete(t.id); emit(); fail(error, "Toevoegen"); return null; }
  return t;
}

export async function updateTask(id, patch, { quiet = false } = {}) {
  const t = state.tasks.get(id);
  if (!t) return false;
  if ("reminder_sent_for" in patch) { patch = { ...patch }; delete patch.reminder_sent_for; }
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = t[k];
  Object.assign(t, patch);
  normTask(t);
  emit();
  const { error } = await tracked([id], sb.from("tasks").update(patch).eq("id", id));
  if (error) {
    Object.assign(t, prev);
    emit();
    if (!quiet) fail(error);
    return false;
  }
  return true;
}

// Zelfde wijziging voor meerdere taken; per taak terugdraaibaar.
export async function updateTasks(ids, patch) {
  if (!ids.length) return true;
  const prev = ids.map((id) => {
    const t = state.tasks.get(id);
    const p = {};
    for (const k of Object.keys(patch)) p[k] = t ? t[k] : undefined;
    if (t) Object.assign(t, patch);
    return [id, p];
  });
  emit();
  const { error } = await tracked(ids, sb.from("tasks").update(patch).in("id", ids));
  if (error) {
    prev.forEach(([id, p]) => { const t = state.tasks.get(id); if (t) Object.assign(t, p); });
    emit();
    fail(error);
    return false;
  }
  return true;
}

// ---------- Datum verzetten (met herinnering mee) ----------
// Lokaal tijdstip van een datum (+ tijd). Zonder tijd: middernacht.
export function dueMoment(date, time = null) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = (time || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}

// Herinnering evenveel verschuiven als de taak verschuift, zodat
// "30 min van tevoren" ook na verzetten 30 min van tevoren blijft.
// Met tijd voor en na: exact verschil. Anders: hele dagen, zelfde kloktijd.
export function shiftedReminder(rem, from, to) {
  if (!rem || !from.due_date || !to.due_date) return rem;
  const r = new Date(rem);
  if (isNaN(r)) return rem;
  const ft = from.due_time ? from.due_time.slice(0, 5) : null;
  const tt = to.due_time ? to.due_time.slice(0, 5) : null;
  if (ft && tt) {
    const delta = dueMoment(to.due_date, tt) - dueMoment(from.due_date, ft);
    return delta ? new Date(r.getTime() + delta).toISOString() : rem;
  }
  const days = Math.round((dueMoment(to.due_date) - dueMoment(from.due_date)) / 864e5);
  if (!days) return rem;
  r.setDate(r.getDate() + days);
  return r.toISOString();
}

// Patch voor een nieuwe datum/tijd/herhaling, inclusief verschoven herinnering.
export function reschedulePatch(t, due) {
  const patch = { ...due };
  const to = {
    due_date: "due_date" in due ? due.due_date : t.due_date,
    due_time: "due_time" in due ? due.due_time : t.due_time,
  };
  const rem = shiftedReminder(t.reminder_at, t, to);
  if (rem !== t.reminder_at) patch.reminder_at = rem;
  return patch;
}

// Eén plek voor elke wijziging van due_date/due_time.
export function rescheduleTask(id, due, opts) {
  const t = state.tasks.get(id);
  if (!t) return Promise.resolve(false);
  return updateTask(id, reschedulePatch(t, due), opts);
}

// Meerdere taken naar dezelfde datum. Taken met een herinnering krijgen elk
// hun eigen verschoven tijd; de rest gaat in één keer.
export async function rescheduleTasks(ids, due) {
  const withRem = ids.filter((id) => state.tasks.get(id)?.reminder_at);
  const plain = ids.filter((id) => !withRem.includes(id));
  const results = await Promise.all([
    plain.length ? updateTasks(plain, due) : true,
    ...withRem.map((id) => rescheduleTask(id, due, { quiet: true })),
  ]);
  if (results.some((ok) => !ok)) { if (results.slice(1).some((ok) => !ok)) fail("tasks"); return false; }
  return true;
}

function descendants(id) {
  const out = [];
  const walk = (pid) => childrenOf(pid).forEach((t) => { out.push(t); walk(t.id); });
  walk(id);
  return out;
}

export async function deleteTask(id) {
  const t = state.tasks.get(id);
  if (!t) return false;
  // Subtaken verdwijnen in de database via cascade; lokaal doen we hetzelfde.
  const removed = [t, ...descendants(id)];
  removed.forEach((x) => state.tasks.delete(x.id));
  emit();
  const { error } = await tracked(removed.map((x) => x.id), sb.from("tasks").delete().eq("id", id));
  if (error) { removed.forEach((x) => state.tasks.set(x.id, x)); emit(); fail(error, "Verwijderen"); return false; }
  return true;
}

export async function duplicateTask(id) {
  const t = state.tasks.get(id);
  if (!t) return null;
  const copyFields = (x, extra) => ({
    project_id: x.project_id, section_id: x.section_id, title: x.title, description: x.description,
    priority: x.priority, due_date: x.due_date, due_time: x.due_time, deadline: x.deadline,
    duration_min: x.duration_min, recurrence: x.recurrence, labels: [...(x.labels || [])],
    reminder_at: x.reminder_at, ...extra,
  });
  const copy = await createTask(copyFields(t, { parent_id: t.parent_id, sort_order: (t.sort_order ?? 0) + 0.5 }));
  if (!copy) return null;
  for (const c of childrenOf(id, { includeCompleted: false })) {
    await createTask(copyFields(c, { parent_id: copy.id, sort_order: c.sort_order }));
  }
  return copy;
}

export function subtaskIds(id) { return descendants(id).filter((t) => !t.completed).map((t) => t.id); }

// ---------- Projecten & secties ----------
export async function createProject({ name, color = DEFAULT_COLOR, favorite = false }) {
  const p = { id: uuid(), name, color, favorite, archived: false,
    sort_order: nextSortOrder(state.projects), created_at: new Date().toISOString() };
  state.projects.push(p);
  emit();
  const row = { ...p }; delete row.created_at;
  const { error } = await tracked([p.id], sb.from("projects").insert(row));
  if (error) { state.projects = state.projects.filter((x) => x.id !== p.id); emit(); fail(error, "Project maken"); return null; }
  return p;
}

async function patchRow(table, list, id, patch) {
  const row = list.find((x) => x.id === id);
  if (!row) return false;
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = row[k];
  Object.assign(row, patch);
  emit();
  const { error } = await tracked([id], sb.from(table).update(patch).eq("id", id));
  if (error) { Object.assign(row, prev); emit(); fail(error); return false; }
  return true;
}

export const updateProject = (id, patch) => patchRow("projects", state.projects, id, patch);
export const updateSection = (id, patch) => patchRow("sections", state.sections, id, patch);
export const updateFilter = (id, patch) => patchRow("filters", state.filters, id, patch);

export async function deleteProject(id) {
  const p = projectById(id);
  if (!p) return false;
  const tasks = allTasks().filter((t) => t.project_id === id);
  const secs = state.sections.filter((s) => s.project_id === id);
  state.projects = state.projects.filter((x) => x.id !== id);
  state.sections = state.sections.filter((s) => s.project_id !== id);
  tasks.forEach((t) => state.tasks.delete(t.id));
  emit();
  // Eerst de taken, dan het project: zo blijft er niets zwevend achter,
  // ook als de foreign key niet cascadet.
  const r3 = await tracked([id, ...secs.map((x) => x.id), ...tasks.map((t) => t.id)], (async () => {
    const r1 = await sb.from("tasks").delete().eq("project_id", id);
    const r2 = r1.error ? r1 : await sb.from("sections").delete().eq("project_id", id);
    return r2.error ? r2 : await sb.from("projects").delete().eq("id", id);
  })());
  if (r3.error) {
    state.projects.push(p); state.sections.push(...secs);
    tasks.forEach((t) => state.tasks.set(t.id, t));
    emit(); fail(r3.error, "Verwijderen"); return false;
  }
  return true;
}

export async function createSection(projectId, name) {
  const s = { id: uuid(), project_id: projectId, name,
    sort_order: nextSortOrder(sectionsOf(projectId)), created_at: new Date().toISOString() };
  state.sections.push(s);
  emit();
  const row = { ...s }; delete row.created_at;
  const { error } = await tracked([s.id], sb.from("sections").insert(row));
  if (error) { state.sections = state.sections.filter((x) => x.id !== s.id); emit(); fail(error, "Sectie maken"); return null; }
  return s;
}

export async function deleteSection(id) {
  const s = sectionById(id);
  if (!s) return false;
  const tasks = allTasks().filter((t) => t.section_id === id);
  state.sections = state.sections.filter((x) => x.id !== id);
  tasks.forEach((t) => state.tasks.delete(t.id));
  emit();
  const r2 = await tracked([id, ...tasks.map((t) => t.id)], (async () => {
    const r1 = await sb.from("tasks").delete().eq("section_id", id);
    return r1.error ? r1 : await sb.from("sections").delete().eq("id", id);
  })());
  if (r2.error) { state.sections.push(s); tasks.forEach((t) => state.tasks.set(t.id, t)); emit(); fail(r2.error, "Verwijderen"); return false; }
  return true;
}

// ---------- Labels ----------
export async function ensureLabels(names) {
  for (const name of names) {
    if (!labelByName(name)) await createLabel(name);
  }
}

export async function createLabel(name, color = DEFAULT_COLOR) {
  if (labelByName(name)) return labelByName(name);
  const l = { id: uuid(), name, color, sort_order: nextSortOrder(state.labels), created_at: new Date().toISOString() };
  state.labels.push(l);
  emit();
  const row = { ...l }; delete row.created_at;
  const { error } = await tracked([l.id], sb.from("labels").insert(row));
  if (error) { state.labels = state.labels.filter((x) => x.id !== l.id); emit(); fail(error, "Label maken"); return null; }
  return l;
}

export async function updateLabel(id, patch) {
  const l = state.labels.find((x) => x.id === id);
  if (!l) return false;
  const oldName = l.name;
  const ok = await patchRow("labels", state.labels, id, patch);
  if (ok && patch.name && patch.name !== oldName) {
    // Taken bewaren labelnamen, dus die hernoemen we mee.
    const affected = allTasks().filter((t) => t.labels.includes(oldName));
    for (const t of affected) {
      await updateTask(t.id, { labels: t.labels.map((x) => (x === oldName ? patch.name : x)) });
    }
  }
  return ok;
}

export async function deleteLabel(id) {
  const l = state.labels.find((x) => x.id === id);
  if (!l) return false;
  state.labels = state.labels.filter((x) => x.id !== id);
  emit();
  const { error } = await tracked([id], sb.from("labels").delete().eq("id", id));
  if (error) { state.labels.push(l); emit(); fail(error, "Verwijderen"); return false; }
  const affected = allTasks().filter((t) => t.labels.includes(l.name));
  for (const t of affected) await updateTask(t.id, { labels: t.labels.filter((x) => x !== l.name) });
  return true;
}

// ---------- Filters ----------
export async function createFilter({ name, query, color = DEFAULT_COLOR }) {
  const f = { id: uuid(), name, query, color, sort_order: nextSortOrder(state.filters), created_at: new Date().toISOString() };
  state.filters.push(f);
  emit();
  const row = { ...f }; delete row.created_at;
  const { error } = await tracked([f.id], sb.from("filters").insert(row));
  if (error) { state.filters = state.filters.filter((x) => x.id !== f.id); emit(); fail(error, "Filter maken"); return null; }
  return f;
}

export async function deleteFilter(id) {
  const f = filterById(id);
  if (!f) return false;
  state.filters = state.filters.filter((x) => x.id !== id);
  emit();
  const { error } = await tracked([id], sb.from("filters").delete().eq("id", id));
  if (error) { state.filters.push(f); emit(); fail(error, "Verwijderen"); return false; }
  return true;
}

// ---------- Instellingen ----------
export const DEFAULT_SETTINGS = { digest_enabled: false, digest_time: "08:00", calendar_token: null };

function normSettings(row) {
  const out = { ...DEFAULT_SETTINGS };
  if (row) {
    out.digest_enabled = !!row.digest_enabled;
    if (row.digest_time) out.digest_time = String(row.digest_time).slice(0, 5);
    out.calendar_token = row.calendar_token || null;
  }
  return out;
}

export function settings() { return state.settings || { ...DEFAULT_SETTINGS }; }

async function userId() {
  if (state.user?.id) return state.user.id;
  const { data } = await sb.auth.getSession();
  return data?.session?.user?.id || null;
}

// Alleen de meegegeven velden; last_digest_date en updated_at beheert de server.
export async function saveSettings(patch) {
  const cur = settings();
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = cur[k];
  state.settings = { ...cur, ...patch };
  emit();
  const id = await userId();
  const { error } = id
    ? await tracked(["settings"], sb.from("user_settings").upsert({ user_id: id, ...patch }, { onConflict: "user_id" }))
    : { error: new Error("niet ingelogd") };
  if (error) { state.settings = { ...settings(), ...prev }; emit(); fail(error); return false; }
  return true;
}

// ---------- Computer (pc-server) ----------
// De pc werkt last_seen elke ~30 s bij zolang de server draait.
export const PC_ONLINE_MS = 90_000;

export async function loadPcStatus() {
  const { data, error } = await sb.from("server_status").select("*").eq("id", "pc").maybeSingle();
  if (error) return; // tabel (nog) niet bereikbaar: status onbekend laten
  state.pcStatus = data || null;
  emit("status");
}

// "online" | "offline" | "missing" | null (onbekend)
export function pcState(now = Date.now()) {
  const s = state.pcStatus;
  if (s === undefined) return null;
  if (!s || !s.last_seen) return "missing";
  const t = new Date(s.last_seen).getTime();
  return !isNaN(t) && now - t <= PC_ONLINE_MS ? "online" : "offline";
}

// "zojuist", "12 min geleden", "2 uur geleden", "vandaag 14:05",
// "gisteren 21:30", "3 dagen geleden", "4 nov."
export function agoText(iso, now = new Date()) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const min = Math.floor((now - d) / 60000);
  if (min < 1) return "zojuist";
  if (min < 60) return `${min} min geleden`;
  if (min < 180) return `${Math.floor(min / 60)} uur geleden`;
  const clock = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days <= 0) return `vandaag ${clock}`;
  if (days === 1) return `gisteren ${clock}`;
  if (days < 7) return `${days} dagen geleden`;
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("nl-NL", opts);
}

// ---------- Notities ----------
// Verwijderen: rij + audiobestand direct uit Supabase. De pc haalt dit
// later vanzelf op via reconcile_with_cloud() in app.py.
export async function deleteNote(note) {
  // Meteen weg uit beeld; bij een fout weer terugzetten.
  state.notes = state.notes.filter((n) => n.id !== note.id);
  emit();
  const { error } = await sb.from("notes").delete().eq("id", note.id);
  if (error) {
    if (!noteById(note.id)) state.notes = [...state.notes, note].sort((a, b) => b.id - a.id);
    emit();
    toast("Verwijderen mislukt: " + error.message);
    return false;
  }
  if (note.audio_path) sb.storage.from("audio").remove([note.audio_path]).catch(() => {});
  // Gekoppelde taken houden we; ze verwijzen alleen niet meer naar de notitie.
  allTasks().forEach((t) => { if (String(t.note_id) === String(note.id)) t.note_id = null; });
  emit();
  return true;
}

// Alleen voor oude notities waarvan de actiepunten (nog) geen taken zijn.
export async function setNoteActionItems(note, items) {
  const prev = note.actionItems;
  note.actionItems = items;
  const { error } = await sb.from("notes").update({ action_items: JSON.stringify(items) }).eq("id", note.id);
  if (error) { note.actionItems = prev; fail(error); return false; }
  return true;
}
