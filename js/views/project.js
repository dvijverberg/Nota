// Project (en Inbox): taken per sectie, inklapbaar, met subtaken eronder.

import { escapeHtml, icon, menuSheet, promptSheet, confirmSheet, toast, actions } from "../ui.js";
import {
  state, projectById, sectionsOf, allTasks, updateProject, deleteProject, createSection,
  updateSection, deleteSection, sectionById, createProject,
} from "../store.js";
import { taskList, sortTasks, isCollapsed, toggleCollapsed } from "../tasks.js";
import { editSheet } from "../pickers.js";
import { intro, emptyState, addInline, getPref, setPref, SORTS } from "./common.js";
import { renderBoard, afterBoard, bindBoard, isBoardDragging } from "./board.js";

function key(params) { return params.id ? "p:" + params.id : "inbox"; }
const isBoard = (p) => !!p && p.view === "board";

function topLevel(projectId, sectionId, showCompleted) {
  return allTasks().filter((t) => (t.project_id || null) === (projectId || null) &&
    (t.section_id || null) === (sectionId || null) && !t.parent_id && (showCompleted || !t.completed));
}

export default {
  tab: (params) => (params.id ? "bladeren" : "inbox"),
  topbar(params) {
    const p = params.id ? projectById(params.id) : null;
    return {
      title: params.id ? (p ? p.name : "Project") : "Inbox",
      back: !!params.id,
      actions: [
        ...(params.id ? [] : [{ act: "search", icon: "search", label: "Zoeken" }]),
        { act: "menu", icon: "more", label: "Weergave-opties" },
      ],
    };
  },
  context: (params) => ({ project_id: params.id || null, section_id: null }),

  render(params) {
    const pid = params.id || null;
    const p = pid ? projectById(pid) : null;
    if (pid && !p) return emptyState("Project niet gevonden", "Misschien is het verwijderd.");
    const sort = getPref("sort:" + key(params), "manual");
    const showDone = getPref("done:" + key(params), false);
    const sortable = sort === "manual";
    const opts = { nested: true, sortable, showCompleted: showDone };
    const order = (list) => {
      const s = sortTasks(list.filter((t) => !t.completed), sort);
      return showDone ? [...s, ...list.filter((t) => t.completed).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))] : s;
    };

    const rootTasks = order(topLevel(pid, null, showDone));
    const sections = pid ? sectionsOf(pid) : [];
    const openTotal = allTasks().filter((t) => (t.project_id || null) === pid && !t.completed).length;
    let html = intro(p ? p.name : "Inbox", `${openTotal} ${openTotal === 1 ? "open taak" : "open taken"}${p && p.favorite ? ` · ${icon("star-fill", "icon-xs fav")}` : ""}${sort !== "manual" ? ` · gesorteerd op ${SORTS.find((s) => s.id === sort).label.toLowerCase()}` : ""}`, { dot: p ? p.color : null });

    if (isBoard(p)) return html + renderBoard(pid, { sort, showDone });

    html += `<section class="group">
      ${rootTasks.length ? `<div class="card">${taskList(rootTasks, opts)}</div>` : ""}
      ${addInline(`data-project="${pid || ""}" data-section=""`)}
    </section>`;

    for (const s of sections) {
      const list = order(topLevel(pid, s.id, showDone));
      const collapsed = isCollapsed("s:" + s.id);
      const openN = list.filter((t) => !t.completed).length;
      html += `<section class="group section-block ${collapsed ? "collapsed" : ""}" data-section-id="${s.id}">
        <div class="group-head sec-head">
          <button type="button" class="sec-toggle" data-act="toggle-section" data-id="${s.id}" aria-expanded="${!collapsed}">
            ${icon("chevron", "icon-sm chev")}<h2>${escapeHtml(s.name)}</h2><span class="count">${openN || ""}</span>
          </button>
          <span class="grow"></span>
          <button type="button" class="icon-btn sm" data-act="section-menu" data-id="${s.id}" aria-label="Opties voor sectie ${escapeHtml(s.name)}">${icon("more", "icon-sm")}</button>
        </div>
        ${collapsed ? "" : `
          ${list.length ? `<div class="card">${taskList(list, opts)}</div>` : ""}
          ${addInline(`data-project="${pid}" data-section="${s.id}"`)}`}
      </section>`;
    }
    if (pid) html += `<button type="button" class="add-section" data-act="add-section">${icon("section", "icon-sm")}Sectie toevoegen</button>`;
    if (!pid && !rootTasks.length) html += emptyState("Je inbox is leeg.", "Alles wat je zonder project toevoegt, komt hier.");
    if (sortable && rootTasks.length > 1) html += `<p class="footnote">Houd een taak ingedrukt om hem te verslepen.</p>`;
    return html;
  },

  // Niet opnieuw opbouwen terwijl er een kaart wordt versleept.
  update: () => isBoardDragging(),
  after(el, params) {
    if (!isBoard(params.id ? projectById(params.id) : null)) return;
    bindBoard(el);
    afterBoard(el);
  },

  async onClick(act, el, params) {
    const pid = params.id || null;
    if (act === "toggle-section") { toggleCollapsed("s:" + el.dataset.id); return "rerender"; }
    if (act === "add-section") {
      const name = await promptSheet({ title: "Nieuwe sectie", placeholder: "Naam van de sectie", ok: "Toevoegen" });
      if (name) createSection(pid, name);
      return;
    }
    if (act === "section-menu") {
      const s = sectionById(el.dataset.id);
      if (!s) return;
      const r = await menuSheet({ title: s.name, groups: [
        { items: [
          { id: "add", label: "Taak toevoegen", icon: "plus" },
          { id: "rename", label: "Naam wijzigen", icon: "edit" },
        ] },
        { items: [{ id: "delete", label: "Sectie verwijderen", icon: "trash", danger: true }] },
      ] });
      if (r === "add") actions.quickAdd({ project_id: pid, section_id: s.id });
      if (r === "rename") {
        const name = await promptSheet({ title: "Sectie hernoemen", value: s.name });
        if (name && name !== s.name) updateSection(s.id, { name });
      }
      if (r === "delete") {
        const n = allTasks().filter((t) => t.section_id === s.id && !t.completed).length;
        const ok = await confirmSheet({ title: "Sectie verwijderen?", text: `“${s.name}”${n ? ` en ${n} ${n === 1 ? "taak" : "taken"}` : ""} worden definitief verwijderd.` });
        if (ok && await deleteSection(s.id)) toast("Sectie verwijderd");
      }
      return;
    }
    if (act === "menu") return projectMenu(params);
  },
};

async function projectMenu(params) {
  const k = key(params);
  const p = params.id ? projectById(params.id) : null;
  const sort = getPref("sort:" + k, "manual");
  const showDone = getPref("done:" + k, false);
  const groups = [];
  if (p) groups.push({ items: [
    { id: "edit", label: "Project bewerken", icon: "edit" },
    { id: "section", label: "Sectie toevoegen", icon: "section" },
    { id: "fav", label: p.favorite ? "Uit favorieten" : "Aan favorieten toevoegen", icon: p.favorite ? "star-fill" : "star" },
  ] });
  if (p) groups.push({ label: "Weergave", items: [
    { id: "view:list", label: "Lijst", checked: !isBoard(p) },
    { id: "view:board", label: "Bord", checked: isBoard(p) },
  ] });
  groups.push({ label: "Sorteren", items: SORTS.map((s) => ({ id: "sort:" + s.id, label: s.label, checked: s.id === sort })) });
  groups.push({ items: [
    { id: "done", label: showDone ? "Voltooide taken verbergen" : "Voltooide taken tonen", icon: "check-circle" },
    { id: "refresh", label: "Vernieuwen", icon: "refresh" },
  ] });
  if (p) groups.push({ items: [
    { id: "archive", label: "Archiveren", icon: "archive" },
    { id: "delete", label: "Project verwijderen", icon: "trash", danger: true },
  ] });
  const r = await menuSheet({ title: p ? p.name : "Inbox", groups });
  if (!r) return;
  if (r.startsWith("view:")) { if (r.slice(5) !== (p.view || "list")) updateProject(p.id, { view: r.slice(5) }); return "rerender"; }
  if (r.startsWith("sort:")) { setPref("sort:" + k, r.slice(5)); return "rerender"; }
  if (r === "done") { setPref("done:" + k, !showDone); return "rerender"; }
  if (r === "refresh") return "refresh";
  if (r === "fav") { updateProject(p.id, { favorite: !p.favorite }); return; }
  if (r === "section") {
    const name = await promptSheet({ title: "Nieuwe sectie", placeholder: "Naam van de sectie", ok: "Toevoegen" });
    if (name) createSection(p.id, name);
    return;
  }
  if (r === "edit") return editProject(p);
  if (r === "archive") {
    await updateProject(p.id, { archived: true });
    toast("Project gearchiveerd", { action: { label: "Ongedaan maken", fn: () => updateProject(p.id, { archived: false }) } });
    actions.navigate("#/bladeren", { replace: true });
    return;
  }
  if (r === "delete") {
    const n = allTasks().filter((t) => t.project_id === p.id && !t.completed).length;
    const ok = await confirmSheet({ title: "Project verwijderen?", text: `“${p.name}”${n ? ` en ${n} open ${n === 1 ? "taak" : "taken"}` : ""} worden definitief verwijderd. Dit kun je niet ongedaan maken.` });
    if (ok) {
      actions.navigate("#/bladeren", { replace: true });
      if (await deleteProject(p.id)) toast("Project verwijderd");
    }
  }
}

export async function editProject(p) {
  const r = await editSheet({ title: p ? "Project bewerken" : "Nieuw project", name: p ? p.name : "", color: p ? p.color : undefined, favorite: p ? !!p.favorite : false, ok: p ? "Opslaan" : "Toevoegen" });
  if (!r) return null;
  if (p) { await updateProject(p.id, { name: r.name, color: r.color, favorite: !!r.favorite }); return p; }
  return createProject({ name: r.name, color: r.color, favorite: !!r.favorite });
}
