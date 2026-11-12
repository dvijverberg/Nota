// Datalaag: alles uit Supabase in het geheugen (één gebruiker, weinig
// data), wijzigingen optimistisch toepassen en bij een fout terugdraaien.

import { toast, uuid } from "./ui.js";

const SUPABASE_URL = "https://rqhrtiexwmgrlzgvrigm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_GQKT1FiA-eudNrKfOY7jcQ_NMrWQQ8Y";
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
  loaded: false,
  // Voltooide taken ouder dan 30 dagen laden we pas in "Voltooid".
  completedSince: null,
  allCompletedLoaded: false,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let emitQueued = false;
// Bundelt meerdere wijzigingen in één render.
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });
  });
}

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
export function childrenOf(taskId, { includeCompleted = true } = {}) {
  return allTasks().filter((t) => t.parent_id === taskId && (includeCompleted || !t.completed)).sort(byOrder);
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
    try {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const [p, s, l, f, open, done, noteDone, n] = await Promise.all([
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
      ]);
      const err = [p, s, l, f, open, done, noteDone, n].find((r) => r.error);
      if (err) return { error: err.error };

      state.projects = p.data || [];
      state.sections = s.data || [];
      state.labels = l.data || [];
      state.filters = f.data || [];
      const tasks = new Map();
      for (const t of [...(open.data || []), ...(done.data || []), ...(noteDone.data || [])]) tasks.set(t.id, normTask(t));
      // Al eerder geladen oudere voltooide taken bewaren.
      if (state.allCompletedLoaded || state.completedSince) {
        for (const t of state.tasks.values()) if (t.completed && !tasks.has(t.id) && t.completed_at < since) tasks.set(t.id, t);
      } else {
        state.completedSince = since;
      }
      state.tasks = tasks;

      const notes = n.data || [];
      // Alle audio-links in één keer ophalen i.p.v. per notitie.
      const paths = notes.map((x) => x.audio_path).filter(Boolean);
      const urlByPath = {};
      if (paths.length) {
        const { data: signed } = await sb.storage.from("audio").createSignedUrls(paths, 3600);
        (signed || []).forEach((x) => { if (x.signedUrl) urlByPath[x.path] = x.signedUrl; });
      }
      for (const note of notes) {
        note.audioUrl = urlByPath[note.audio_path] || null;
        note.actionItems = normalizeActionItems(note.action_items);
      }
      state.notes = notes;
      state.loaded = true;
      emit();
      return { error: null };
    } finally {
      loading = null;
    }
  })();
  return loading;
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
  delete row.created_at; delete row.updated_at;
  const { error } = await sb.from("tasks").insert(row);
  if (error) { state.tasks.delete(t.id); emit(); fail(error, "Toevoegen"); return null; }
  return t;
}

export async function updateTask(id, patch, { quiet = false } = {}) {
  const t = state.tasks.get(id);
  if (!t) return false;
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = t[k];
  Object.assign(t, patch);
  normTask(t);
  emit();
  const { error } = await sb.from("tasks").update(patch).eq("id", id);
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
  const { error } = await sb.from("tasks").update(patch).in("id", ids);
  if (error) {
    prev.forEach(([id, p]) => { const t = state.tasks.get(id); if (t) Object.assign(t, p); });
    emit();
    fail(error);
    return false;
  }
  return true;
}

function descendants(id) {
  const out = [];
  const walk = (pid) => allTasks().forEach((t) => { if (t.parent_id === pid) { out.push(t); walk(t.id); } });
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
  const { error } = await sb.from("tasks").delete().eq("id", id);
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
  const { error } = await sb.from("projects").insert(row);
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
  const { error } = await sb.from(table).update(patch).eq("id", id);
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
  const r1 = await sb.from("tasks").delete().eq("project_id", id);
  const r2 = r1.error ? r1 : await sb.from("sections").delete().eq("project_id", id);
  const r3 = r2.error ? r2 : await sb.from("projects").delete().eq("id", id);
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
  const { error } = await sb.from("sections").insert(row);
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
  const r1 = await sb.from("tasks").delete().eq("section_id", id);
  const r2 = r1.error ? r1 : await sb.from("sections").delete().eq("id", id);
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
  const { error } = await sb.from("labels").insert(row);
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
  const { error } = await sb.from("labels").delete().eq("id", id);
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
  const { error } = await sb.from("filters").insert(row);
  if (error) { state.filters = state.filters.filter((x) => x.id !== f.id); emit(); fail(error, "Filter maken"); return null; }
  return f;
}

export async function deleteFilter(id) {
  const f = filterById(id);
  if (!f) return false;
  state.filters = state.filters.filter((x) => x.id !== id);
  emit();
  const { error } = await sb.from("filters").delete().eq("id", id);
  if (error) { state.filters.push(f); emit(); fail(error, "Verwijderen"); return false; }
  return true;
}

// ---------- Notities ----------
// Verwijderen: rij + audiobestand direct uit Supabase. De pc haalt dit
// later vanzelf op via reconcile_with_cloud() in app.py.
export async function deleteNote(note) {
  const { error } = await sb.from("notes").delete().eq("id", note.id);
  if (error) { toast("Verwijderen mislukt: " + error.message); return false; }
  if (note.audio_path) await sb.storage.from("audio").remove([note.audio_path]);
  state.notes = state.notes.filter((n) => n.id !== note.id);
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
