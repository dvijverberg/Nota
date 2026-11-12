// Gedeelde stukjes voor de views.

import { escapeHtml, icon } from "../ui.js";

// Weergave-opties per view (sorteren, voltooide tonen). Alleen gemak per
// toestel, dus localStorage is prima.
export function getPref(key, def) {
  try { const v = localStorage.getItem("nota-view:" + key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
export function setPref(key, val) {
  try { localStorage.setItem("nota-view:" + key, JSON.stringify(val)); } catch {}
}

export function intro(title, sub = "", { dot = null, ic = null } = {}) {
  return `
    <section class="intro">
      <h1>${dot ? `<span class="title-dot" style="--c:${escapeHtml(dot)}"></span>` : ""}${ic ? icon(ic, "title-ic") : ""}${escapeHtml(title)}</h1>
      ${sub ? `<p>${sub}</p>` : ""}
    </section>`;
}

export function emptyState(title, text = "", extra = "") {
  return `
    <div class="empty">
      <svg width="48" height="48" aria-hidden="true"><use href="#i-rings"/></svg>
      <h3>${escapeHtml(title)}</h3>
      ${text ? `<p>${escapeHtml(text)}</p>` : ""}
      ${extra}
    </div>`;
}

export function addInline(attrs = "", label = "Taak toevoegen") {
  return `<button type="button" class="add-inline" data-act="add" ${attrs}>${icon("plus", "icon-sm")}${escapeHtml(label)}</button>`;
}

export function groupHead(title, { count = null, right = "", cls = "" } = {}) {
  return `
    <div class="group-head ${cls}">
      <h2>${title}</h2>
      ${count != null ? `<span class="count">${count}</span>` : ""}
      <span class="grow"></span>
      ${right}
    </div>`;
}

export const SORTS = [
  { id: "manual", label: "Handmatig" },
  { id: "date", label: "Datum" },
  { id: "priority", label: "Prioriteit" },
  { id: "name", label: "Naam" },
];

export const WD_SHORT = ["zo", "ma", "di", "wo", "do", "vr", "za"];
export const MONTH_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
export const MONTH_LONG = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
