// Label-, filter- en voltooid-weergaven.

import { matchesFilter, validateFilter } from "../parse.js";
import { escapeHtml, icon, menuSheet, confirmSheet, toast, actions, capitalize } from "../ui.js";
import {
  state, openTasks, allTasks, labelByName, updateLabel, deleteLabel, filterById, updateFilter,
  deleteFilter, projectsById, loadOlderCompleted,
} from "../store.js";
import { taskList, sortTasks } from "../tasks.js";
import { editSheet } from "../pickers.js";
import { intro, emptyState, WD_SHORT, MONTH_LONG } from "./common.js";

export function sectionsById() {
  const m = {};
  state.sections.forEach((s) => { m[s.id] = s; });
  return m;
}

export function filterTasks(query) {
  const ctx = { now: new Date(), projectsById: projectsById(), sectionsById: sectionsById() };
  return openTasks().filter((t) => matchesFilter(t, query, ctx));
}

export function validateWithCount(q) {
  const r = validateFilter(q);
  return r.ok ? { ok: true, count: filterTasks(q).length } : r;
}

export const labelView = {
  tab: "bladeren",
  topbar: (params) => ({ title: params.name, back: true, actions: [{ act: "menu", icon: "more", label: "Labelopties" }] }),
  context: (params) => ({ labels: [params.name] }),
  render(params) {
    const l = labelByName(params.name);
    const tasks = sortTasks(openTasks().filter((t) => t.labels.some((x) => x.toLowerCase() === params.name.toLowerCase())), "date");
    let html = intro(params.name, `${tasks.length} ${tasks.length === 1 ? "taak" : "taken"}`, { ic: "tag" });
    html = html.replace('class="intro"', `class="intro" style="--ic:${escapeHtml(l?.color || "var(--muted)")}"`);
    html += tasks.length ? `<section class="group"><div class="card">${taskList(tasks, { showProject: true })}</div></section>`
      : emptyState("Geen taken met dit label.", "Typ @" + params.name + " in een nieuwe taak om hem hier te zien.");
    return html;
  },
  async onClick(act, el, params) {
    if (act !== "menu") return;
    const l = labelByName(params.name);
    const r = await menuSheet({ title: params.name, groups: [
      { items: [{ id: "edit", label: "Label bewerken", icon: "edit" }] },
      ...(l ? [{ items: [{ id: "delete", label: "Label verwijderen", icon: "trash", danger: true }] }] : []),
    ] });
    if (r === "edit") {
      const res = await editSheet({ title: "Label bewerken", name: l ? l.name : params.name, color: l?.color });
      if (!res) return;
      if (l) {
        await updateLabel(l.id, { name: res.name, color: res.color });
        if (res.name !== params.name) actions.navigate("#/label/" + encodeURIComponent(res.name), { replace: true });
      }
    }
    if (r === "delete") {
      const ok = await confirmSheet({ title: "Label verwijderen?", text: `“${l.name}” wordt van alle taken gehaald. De taken zelf blijven bestaan.` });
      if (ok) { actions.navigate("#/bladeren", { replace: true }); if (await deleteLabel(l.id)) toast("Label verwijderd"); }
    }
  },
};

export const filterView = {
  tab: "bladeren",
  topbar: (params) => ({ title: filterById(params.id)?.name || "Filter", back: true, actions: [{ act: "menu", icon: "more", label: "Filteropties" }] }),
  render(params) {
    const f = filterById(params.id);
    if (!f) return emptyState("Filter niet gevonden", "Misschien is hij verwijderd.");
    const v = validateFilter(f.query);
    const tasks = v.ok ? sortTasks(filterTasks(f.query), "date") : [];
    let html = intro(f.name, `<code>${escapeHtml(f.query)}</code> · ${tasks.length} ${tasks.length === 1 ? "taak" : "taken"}`, { ic: "filter" });
    html = html.replace('class="intro"', `class="intro" style="--ic:${escapeHtml(f.color || "var(--muted)")}"`);
    if (!v.ok) html += emptyState("Deze filter klopt niet.", v.error, `<button type="button" class="btn-ghost" data-act="menu">Filter bewerken</button>`);
    else html += tasks.length ? `<section class="group"><div class="card">${taskList(tasks, { showProject: true })}</div></section>`
      : emptyState("Niets gevonden.", "Er zijn nu geen open taken die hierbij passen.");
    return html;
  },
  async onClick(act, el, params) {
    if (act !== "menu") return;
    const f = filterById(params.id);
    if (!f) return;
    const r = await menuSheet({ title: f.name, groups: [
      { items: [{ id: "edit", label: "Filter bewerken", icon: "edit" }] },
      { items: [{ id: "delete", label: "Filter verwijderen", icon: "trash", danger: true }] },
    ] });
    if (r === "edit") {
      const res = await editSheet({ title: "Filter bewerken", name: f.name, color: f.color, query: f.query, validate: validateWithCount });
      if (res) updateFilter(f.id, { name: res.name, color: res.color, query: res.query });
    }
    if (r === "delete") {
      const ok = await confirmSheet({ title: "Filter verwijderen?", text: `“${f.name}” wordt verwijderd. Je taken blijven bestaan.` });
      if (ok) { actions.navigate("#/bladeren", { replace: true }); if (await deleteFilter(f.id)) toast("Filter verwijderd"); }
    }
  },
};

function dayLabel(d) {
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Vandaag";
  if (d.toDateString() === y.toDateString()) return "Gisteren";
  const s = d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
  return capitalize(s);
}

export const completedView = {
  tab: "bladeren",
  topbar: () => ({ title: "Voltooid", back: true, actions: [] }),
  render() {
    const done = allTasks().filter((t) => t.completed)
      .sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
    let html = intro("Voltooid", done.length ? `${done.length} ${done.length === 1 ? "taak" : "taken"}${state.allCompletedLoaded ? "" : " in de laatste 30 dagen"}` : "");
    if (!done.length && state.allCompletedLoaded) return html + emptyState("Nog niets voltooid.", "Afgevinkte taken verschijnen hier.");
    let lastKey = null, group = [];
    const flush = () => {
      if (!group.length) return;
      html += `<section class="group"><div class="group-head"><h2>${escapeHtml(lastKey)}</h2><span class="count">${group.length}</span></div>
        <div class="card">${taskList(group, { showProject: true })}</div></section>`;
      group = [];
    };
    for (const t of done) {
      const d = t.completed_at ? new Date(t.completed_at) : null;
      const k = d && !isNaN(d) ? dayLabel(d) : "Onbekende datum";
      if (k !== lastKey) { flush(); lastKey = k; }
      group.push(t);
    }
    flush();
    if (!done.length) html += emptyState("Niets voltooid in de laatste 30 dagen.");
    if (!state.allCompletedLoaded) html += `<button type="button" class="btn-ghost center" data-act="older">Oudere laden</button>`;
    return html;
  },
  async onClick(act, el) {
    if (act === "older") {
      el.disabled = true;
      el.innerHTML = `<svg class="icon-sm spin"><use href="#i-rings"/></svg>Laden`;
      await loadOlderCompleted();
    }
  },
};
