// Productiviteit: voltooide taken per dag (tabel task_completions).
// Gewone taken krijgen hun rij van een trigger in de database; herhalende
// taken gaan niet op "voltooid", daarvoor voegt de app zelf een rij toe.
// Lokaal houden we de lijst bij, zodat tellers meteen kloppen.

import { sb, state, emit, settings, onCompletion } from "./store.js";
import { uuid } from "./ui.js";

const DAYS = 90;
let rows = null;      // nieuwste eerst; null = nog niet geladen
let loading = null;
let pulseUntil = 0;

const pad = (n) => String(n).padStart(2, "0");
// Lokale datum "jjjj-mm-dd" van een Date of ISO-tijd.
export function dayKey(x) {
  const d = x instanceof Date ? x : new Date(x);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// 1 = ma … 7 = zo
export const isoDay = (d) => ((d.getDay() + 6) % 7) + 1;
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
export function weekStart(d = new Date()) { return addDays(d, 1 - isoDay(d)); }

export function completionsLoaded() { return rows !== null; }
export function completionRows() { return rows || []; }

export function loadCompletions() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const since = addDays(new Date(), -DAYS).toISOString();
      const { data, error } = await sb.from("task_completions").select("*")
        .gte("completed_at", since).order("completed_at", { ascending: false });
      if (error) { console.warn("Productiviteit laden mislukt:", error); if (rows === null) rows = []; emit(); return; }
      rows = data || [];
      emit();
    } finally { loading = null; }
  })();
  return loading;
}

function sortRows() { rows.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))); }

// Spiegel van de trigger: afvinken = rij erbij, terugzetten = laatste rij weg.
onCompletion((t, done) => {
  if (!rows) return;
  if (done) {
    rows.push({ id: "local-" + uuid(), task_id: t.id, title: t.title, project_id: t.project_id || null,
      recurring: false, completed_at: t.completed_at || new Date().toISOString() });
    sortRows();
  } else {
    const i = rows.findIndex((r) => r.task_id === t.id && !r.recurring);
    if (i >= 0) rows.splice(i, 1);
  }
});

// Herhalende taak afgevinkt: zelf een rij toevoegen. Geeft een functie
// terug die hem weer weghaalt (ongedaan maken).
export function recordRecurring(t) {
  const row = { id: uuid(), task_id: t.id, title: t.title, project_id: t.project_id || null,
    recurring: true, completed_at: new Date().toISOString() };
  if (rows) { rows.push(row); sortRows(); }
  const saved = sb.from("task_completions").insert(row).then(({ error }) => {
    if (error) { console.warn("Voltooiing opslaan mislukt:", error); if (rows) rows = rows.filter((r) => r.id !== row.id); emit(); }
    return !error;
  });
  return async () => {
    if (rows) { rows = rows.filter((r) => r.id !== row.id); emit(); }
    if (await saved) {
      const { error } = await sb.from("task_completions").delete().eq("id", row.id);
      if (error) console.warn("Voltooiing verwijderen mislukt:", error);
    }
  };
}

// ---------- Cijfers ----------
export function goals() {
  const s = settings();
  return { daily: s.daily_goal, weekly: s.weekly_goal, vacation: !!s.vacation_mode, daysOff: s.days_off || [] };
}

export function countsByDay() {
  const m = new Map();
  for (const r of completionRows()) { const k = dayKey(r.completed_at); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

export function todayCount(now = new Date()) {
  const k = dayKey(now);
  return completionRows().filter((r) => dayKey(r.completed_at) === k).length;
}

// Reeks: dagen op rij met het dagdoel gehaald, terug vanaf vandaag (of
// gisteren als vandaag nog niet gehaald is). Vrije dagen tellen niet en
// breken niet. Met vakantiemodus breken de recente gemiste dagen niet.
export function streaks(now = new Date()) {
  const { daily, daysOff, vacation } = goals();
  const counts = countsByDay();
  const met = (d) => (counts.get(dayKey(d)) || 0) >= daily;
  const off = (d) => daysOff.includes(isoDay(d));

  let current = 0;
  let d = met(now) ? new Date(now) : addDays(now, -1);
  let i = 0;
  if (vacation) while (i < DAYS && (off(d) || !met(d))) { d = addDays(d, -1); i++; }
  for (; i < DAYS; i++, d = addDays(d, -1)) {
    if (off(d)) continue;
    if (!met(d)) break;
    current++;
  }

  let longest = 0, run = 0;
  const today = dayKey(now);
  for (let k = DAYS; k >= 0; k--) {
    const x = addDays(now, -k);
    if (off(x)) continue;
    if (met(x)) { run++; longest = Math.max(longest, run); }
    else if (dayKey(x) !== today) run = 0;
  }
  return { current, longest: Math.max(longest, current) };
}

// Ma–zo van deze week: [{ date, key, count, isToday, future, off }]
export function weekDays(now = new Date()) {
  const counts = countsByDay();
  const start = weekStart(now);
  const today = dayKey(now);
  const off = goals().daysOff;
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const key = dayKey(d);
    return { date: d, key, count: counts.get(key) || 0, isToday: key === today, future: key > today, off: off.includes(i + 1) };
  });
}

// Afgelopen weken (oudste eerst), deze week als laatste.
export function lastWeeks(n = 4, now = new Date()) {
  const counts = countsByDay();
  const start = weekStart(now);
  return Array.from({ length: n }, (_, i) => {
    const s = addDays(start, -7 * (n - 1 - i));
    let count = 0;
    for (let j = 0; j < 7; j++) count += counts.get(dayKey(addDays(s, j))) || 0;
    return { start: s, count, current: i === n - 1 };
  });
}

export function weekRows(now = new Date()) {
  const from = dayKey(weekStart(now));
  return completionRows().filter((r) => dayKey(r.completed_at) >= from);
}

// ---------- Dagdoel gehaald ----------
// Eén keer per dag melden. Geeft true als dit de keer is.
export function goalJustReached(before, now = new Date()) {
  if (!completionsLoaded()) return false;
  const goal = goals().daily;
  if (before >= goal || todayCount(now) < goal) return false;
  const key = "nota-goal:" + dayKey(now);
  try { if (localStorage.getItem(key)) return false; localStorage.setItem(key, "1"); } catch {}
  pulseUntil = Date.now() + 1200;
  return true;
}
export function pulsing() { return Date.now() < pulseUntil; }

export { state };
