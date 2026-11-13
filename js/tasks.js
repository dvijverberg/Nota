// Taakrijen: opmaak, afvinken (met ongedaan maken), vegen en slepen.

import { formatDue, nextOccurrence, todayStr } from "./parse.js";
import { escapeHtml, highlight, icon, CHECK_SVG, haptic, toast, actions, reducedMotion } from "./ui.js";
import {
  state, getTask, projectById, sectionById, childrenOf, updateTask, updateTasks,
  subtaskIds, noteById, byOrder, rescheduleTask,
} from "./store.js";
import { commentMeta } from "./comments.js";

export const PRIORITIES = [
  { p: 1, name: "Prioriteit 1", color: "var(--p1)" },
  { p: 2, name: "Prioriteit 2", color: "var(--p2)" },
  { p: 3, name: "Prioriteit 3", color: "var(--p3)" },
  { p: 4, name: "Prioriteit 4", color: "var(--muted)" },
];

export function dueInfo(t) {
  if (!t.due_date) return null;
  try { return formatDue(t.due_date, t.due_time || null, new Date()); }
  catch { return { text: t.due_date, tone: "later" }; }
}

// opts: { showProject, query, sortable, depth, collapsed, showSection, noteContext }
export function taskRow(t, opts = {}) {
  const kids = childrenOf(t.id);
  const kidsDone = kids.filter((k) => k.completed).length;
  let due = dueInfo(t);
  // In Vandaag hoeft er niet bij elke taak "Vandaag" te staan: alleen de tijd.
  if (due && opts.hideToday && due.tone === "today") due = t.due_time ? { ...due, text: t.due_time } : (t.recurrence ? { ...due, text: "" } : null);
  const meta = [];
  if (due) {
    meta.push(`<span class="meta-due tone-${due.tone}">${due.text ? icon("calendar", "icon-xs") + escapeHtml(due.text) : ""}${t.recurrence ? icon("repeat", "icon-xs") : ""}</span>`);
  } else if (t.recurrence) {
    meta.push(`<span class="meta-due">${icon("repeat", "icon-xs")}</span>`);
  }
  if (t.deadline) meta.push(`<span class="meta-deadline">${icon("target", "icon-xs")}${escapeHtml(shortDate(t.deadline))}</span>`);
  if (t.reminder_at && !t.completed) meta.push(`<span class="meta-icon meta-bell" title="Herinnering">${icon("bell", "icon-xs")}</span>`);
  if (kids.length && !opts.hideSubCount) meta.push(`<span class="meta-sub">${icon("subtask", "icon-xs")}${kidsDone}/${kids.length}</span>`);
  if (t.description) meta.push(`<span class="meta-icon" title="Beschrijving">${icon("text", "icon-xs")}</span>`);
  meta.push(...commentMeta(t.id));
  if (t.note_id && !opts.noteContext) meta.push(`<span class="meta-icon" title="Uit spraaknotitie">${icon("mic", "icon-xs")}</span>`);
  for (const l of t.labels || []) meta.push(`<span class="meta-label">${icon("tag", "icon-xs")}${highlight(l, opts.query)}</span>`);
  let place = "";
  if (opts.showProject) {
    const p = t.project_id ? projectById(t.project_id) : null;
    const s = t.section_id ? sectionById(t.section_id) : null;
    const name = p ? p.name + (s ? " / " + s.name : "") : "Inbox";
    place = `<span class="meta-project"><span>${escapeHtml(name)}</span><span class="pdot" style="--c:${p ? escapeHtml(p.color) : "var(--muted)"}"></span></span>`;
  }
  const hasKids = kids.some((k) => !k.completed) && opts.nested;
  const collapsed = hasKids && isCollapsed("t:" + t.id);
  const prio = t.priority || 4;
  return `
    <li class="task ${t.completed ? "done" : ""}" data-task-id="${t.id}" style="--depth:${opts.depth || 0}">
      <div class="task-swipe" aria-hidden="true"><span class="sw-left">${icon("check")}</span><span class="sw-right">${icon("calendar")}</span></div>
      <div class="task-row">
        <button type="button" class="check prio-${prio}" aria-pressed="${!!t.completed}"
          aria-label="${t.completed ? "Markeer als open" : "Afvinken"}: ${escapeHtml(t.title)}">${CHECK_SVG}</button>
        <div class="task-body" tabindex="0" role="button" aria-label="Taak openen: ${escapeHtml(t.title)}">
          <span class="task-title">${highlight(t.title, opts.query)}</span>
          ${opts.query && t.description && t.description.toLowerCase().includes(opts.query.toLowerCase())
            ? `<span class="task-desc">${highlight(snippet(t.description, opts.query), opts.query)}</span>` : ""}
          ${meta.length || place ? `<span class="task-meta"><span class="meta-l">${meta.join("")}</span>${place}</span>` : ""}
        </div>
        ${hasKids ? `<button type="button" class="icon-btn sub-toggle" aria-expanded="${!collapsed}" aria-label="Subtaken ${collapsed ? "tonen" : "verbergen"}">${icon("chevron", "icon-sm")}</button>` : ""}
      </div>
    </li>`;
}

function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 90);
  const start = Math.max(0, i - 30);
  return (start ? "…" : "") + text.slice(start, i + q.length + 60);
}

export function shortDate(d) {
  try {
    const x = new Date(d + "T12:00:00");
    return x.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
  } catch { return d; }
}

// Lijst met taken, subtaken ingesprongen eronder (in project/inbox).
export function taskList(tasks, opts = {}) {
  if (!tasks.length) return "";
  let html = "";
  const add = (t, depth) => {
    html += taskRow(t, { ...opts, depth, nested: opts.nested });
    if (opts.nested && !isCollapsed("t:" + t.id)) {
      const kids = childrenOf(t.id).filter((k) => opts.showCompleted || !k.completed);
      kids.forEach((k) => add(k, depth + 1));
    }
  };
  tasks.forEach((t) => add(t, 0));
  return `<ul class="task-list" ${opts.sortable ? 'data-sortable="1"' : ""}>${html}</ul>`;
}

// ---------- Inklappen (per toestel, alleen gemak) ----------
let collapsedSet;
function loadCollapsed() {
  if (collapsedSet) return collapsedSet;
  try { collapsedSet = new Set(JSON.parse(localStorage.getItem("nota-collapsed") || "[]")); }
  catch { collapsedSet = new Set(); }
  return collapsedSet;
}
export function isCollapsed(key) { return loadCollapsed().has(key); }
export function toggleCollapsed(key) {
  const s = loadCollapsed();
  if (s.has(key)) s.delete(key); else s.add(key);
  try { localStorage.setItem("nota-collapsed", JSON.stringify([...s])); } catch {}
  return s.has(key);
}

// ---------- Afvinken ----------
// Visueel eerst (vinkje, doorstrepen), na ~600ms pas echt weg, met een
// toast om het terug te draaien. Herhalende taken schuiven door naar de
// volgende keer i.p.v. af te gaan, net als in Todoist.
const pendingComplete = new Map();

export function completeTask(id, { rowEl, keepVisible = false } = {}) {
  const t = getTask(id);
  if (!t || pendingComplete.has(id)) return;
  haptic();
  // data-busy: deze rij niet bijwerken zolang het afvinken loopt (morph.js).
  if (rowEl) { rowEl.classList.add("completing", "done"); rowEl.dataset.busy = "1"; }
  const delay = rowEl && !keepVisible && !reducedMotion() ? 600 : 0;

  const run = async () => {
    pendingComplete.delete(id);
    if (rowEl) delete rowEl.dataset.busy;
    if (t.recurrence && t.due_date) {
      let next;
      try { next = nextOccurrence(t.recurrence, t.due_date, { now: new Date() }); } catch { next = null; }
      if (next) {
        const prevDate = t.due_date;
        if (rowEl) rowEl.classList.remove("completing", "done");
        const ok = await rescheduleTask(id, { due_date: next });
        if (ok) {
          const d = formatDue(next, t.due_time || null, new Date());
          toast(`Volgende keer: ${d.text}`, { action: { label: "Ongedaan maken", fn: () => rescheduleTask(id, { due_date: prevDate }) } });
        }
        return;
      }
    }
    const kids = subtaskIds(id);
    const at = new Date().toISOString();
    const ok = await updateTasks([id, ...kids], { completed: true, completed_at: at });
    if (ok) {
      toast("Voltooid", { action: { label: "Ongedaan maken", fn: () => updateTasks([id, ...kids], { completed: false, completed_at: null }) } });
    }
  };
  if (delay) pendingComplete.set(id, setTimeout(run, delay)); else { pendingComplete.set(id, 0); run(); }
}

export function uncompleteTask(id) {
  return updateTasks([id], { completed: false, completed_at: null });
}

export function toggleTask(id, rowEl, opts) {
  const t = getTask(id);
  if (!t) return;
  if (t.completed) { haptic(); uncompleteTask(id); }
  else completeTask(id, { rowEl, ...opts });
}

// ---------- Interactie op lijsten ----------
// Eén set listeners op de view-container: tikken, afvinken, vegen
// (rechts = afvinken, links = inplannen) en lang indrukken om te slepen.
export function bindTaskInteractions(root, { onSchedule, keepVisible = () => false, gestures = true } = {}) {
  let suppressClick = false;

  root.addEventListener("click", (e) => {
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; return; }
    const li = e.target.closest("li.task");
    if (!li || !root.contains(li)) return;
    const id = li.dataset.taskId;
    if (e.target.closest(".check")) { toggleTask(id, li, { keepVisible: keepVisible(li) }); return; }
    if (e.target.closest(".sub-toggle")) {
      toggleCollapsed("t:" + id);
      actions.rerender();
      return;
    }
    actions.openTask(id);
  }, true);

  root.addEventListener("keydown", (e) => {
    const li = e.target.closest && e.target.closest("li.task");
    if (!li || e.target.closest("button")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); actions.openTask(li.dataset.taskId); }
  });

  if (!gestures) return;
  // Vegen + slepen met pointer events
  let g = null;
  const SWIPE = 84;

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const li = e.target.closest("li.task");
    if (!li || e.target.closest(".check, .sub-toggle") || li.classList.contains("completing")) return;
    const row = li.querySelector(".task-row");
    g = { li, row, x: e.clientX, y: e.clientY, dx: 0, dy: 0, mode: null, id: e.pointerId, list: li.closest("ul.task-list") };
    if (g.list && g.list.dataset.sortable) {
      g.hold = setTimeout(() => startDrag(), 380);
    }
  });

  function startDrag() {
    if (!g || g.mode) return;
    g.mode = "drag";
    haptic();
    const rect = g.li.getBoundingClientRect();
    g.startTop = rect.top;
    g.h = rect.height;
    g.li.classList.add("dragging");
    g.items = [...g.list.children].filter((x) => x.matches("li.task"));
    g.index = g.items.indexOf(g.li);
    g.mids = g.items.map((it) => { const r = it.getBoundingClientRect(); return r.top + r.height / 2; });
    g.target = g.index;
    document.body.classList.add("is-dragging");
  }

  window.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (!g.mode) {
      if (Math.abs(g.dx) > 10 || Math.abs(g.dy) > 10) clearTimeout(g.hold);
      if (Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.3) {
        g.mode = "swipe";
        g.li.classList.add("swiping");
        g.row.style.transition = "none";
      } else if (Math.abs(g.dy) > 12) {
        // Gewoon scrollen.
        cleanup();
        return;
      } else return;
    }
    if (g.mode === "swipe") {
      const dx = Math.max(-160, Math.min(160, g.dx));
      g.row.style.transform = `translateX(${dx}px)`;
      g.li.classList.toggle("sw-on-left", dx > SWIPE);
      g.li.classList.toggle("sw-on-right", dx < -SWIPE);
      g.li.classList.toggle("sw-dir-left", dx > 0);
      g.li.classList.toggle("sw-dir-right", dx < 0);
    } else if (g.mode === "drag") {
      e.preventDefault();
      g.li.style.transform = `translateY(${g.dy}px)`;
      // Doelpositie: hoeveel andere rijen liggen (oorspronkelijk) boven het
      // midden van de gesleepte rij.
      const mid = g.startTop + g.dy + g.h / 2;
      g.target = g.items.reduce((n, it, i) => n + (it !== g.li && g.mids[i] < mid ? 1 : 0), 0);
      g.items.forEach((it, i) => {
        if (it === g.li) return;
        const j = i < g.index ? i : i - 1;
        let shift = 0;
        if (j >= g.target && i < g.index) shift = g.h;
        if (j < g.target && i > g.index) shift = -g.h;
        it.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    }
  }, { passive: false });

  // Tijdens slepen mag de pagina niet scrollen (iOS: touchmove tegenhouden).
  document.addEventListener("touchmove", (e) => { if (g && g.mode === "drag") e.preventDefault(); }, { passive: false });

  const end = (e) => {
    if (!g || (e && e.pointerId !== g.id)) return;
    clearTimeout(g.hold);
    const cur = g;
    if (cur.mode === "swipe") {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 50);
      cur.row.style.transition = "";
      const id = cur.li.dataset.taskId;
      if (cur.dx > SWIPE) {
        cur.row.style.transform = "";
        completeTask(id, { rowEl: cur.li });
      } else if (cur.dx < -SWIPE) {
        cur.row.style.transform = "";
        onSchedule && onSchedule(id);
      } else {
        cur.row.style.transform = "";
      }
      cur.li.classList.remove("swiping", "sw-on-left", "sw-on-right", "sw-dir-left", "sw-dir-right");
    } else if (cur.mode === "drag") {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 50);
      finishDrag(cur);
    }
    g = null;
  };
  function cleanup() {
    if (!g) return;
    clearTimeout(g.hold);
    g = null;
  }
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", (e) => {
    if (g && g.mode === "drag") return; // slepen gaat door via touchmove-blokkade
    if (g && g.mode === "swipe") { g.row.style.transform = ""; g.row.style.transition = ""; g.li.classList.remove("swiping"); }
    cleanup();
  });
  root.addEventListener("contextmenu", (e) => { if (e.target.closest("li.task")) e.preventDefault(); });
}

function finishDrag(g) {
  document.body.classList.remove("is-dragging");
  g.items.forEach((it) => { it.style.transform = ""; });
  g.li.classList.remove("dragging");
  if (g.target === g.index) return;
  // Alleen tussen taken met dezelfde ouder/sectie: nieuwe sort_order is het
  // midden tussen de buren.
  const moved = getTask(g.li.dataset.taskId);
  const order = g.items.map((it) => getTask(it.dataset.taskId)).filter(Boolean);
  const without = order.filter((t) => t !== moved);
  without.splice(g.target, 0, moved);
  const sibs = without.filter((t) => (t.parent_id || null) === (moved.parent_id || null));
  const i = sibs.indexOf(moved);
  const prev = sibs[i - 1], next = sibs[i + 1];
  let so;
  if (prev && next) so = (prev.sort_order + next.sort_order) / 2;
  else if (prev) so = prev.sort_order + 1;
  else if (next) so = next.sort_order - 1;
  else return;
  updateTask(moved.id, { sort_order: so });
}

// ---------- Sorteren ----------
export function sortTasks(tasks, mode = "manual") {
  const arr = [...tasks];
  if (mode === "date") {
    arr.sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
      (a.due_time || "99").localeCompare(b.due_time || "99") || (a.priority || 4) - (b.priority || 4) || byOrder(a, b));
  } else if (mode === "priority") {
    arr.sort((a, b) => (a.priority || 4) - (b.priority || 4) || byOrder(a, b));
  } else if (mode === "name") {
    arr.sort((a, b) => a.title.localeCompare(b.title, "nl"));
  } else {
    arr.sort(byOrder);
  }
  return arr;
}

// Vandaag-volgorde: eerst met tijd (op tijd), dan op prioriteit.
export function sortByTimePrio(a, b) {
  if (a.due_time && b.due_time) return a.due_time.localeCompare(b.due_time) || (a.priority || 4) - (b.priority || 4);
  if (a.due_time) return -1;
  if (b.due_time) return 1;
  return (a.priority || 4) - (b.priority || 4) || byOrder(a, b);
}

export function sourceNote(t) { return t.note_id ? noteById(t.note_id) : null; }
export { todayStr, state };
