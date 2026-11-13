// Zoeken over taken (titel/beschrijving) en notities (titel/samenvatting/transcriptie).

import { escapeHtml, highlight, icon, actions } from "../ui.js";
import { state, allTasks, labelColor, labelName } from "../store.js";
import { taskList } from "../tasks.js";
import { emptyState } from "./common.js";
import { loadCommentIndex, searchComments } from "../comments.js";

let q = "";
let rootEl = null;

function snippet(text, query, len = 110) {
  const t = String(text || "");
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return t.slice(0, len) + (t.length > len ? "…" : "");
  const start = Math.max(0, i - 40);
  return (start ? "…" : "") + t.slice(start, start + len) + (start + len < t.length ? "…" : "");
}

function results() {
  const query = q.trim();
  if (!query) return `<p class="search-hint">Zoek in je taken en notities.</p>`;
  const l = query.toLowerCase();
  const tasks = allTasks().filter((t) => (t.title + "\n" + (t.description || "")).toLowerCase().includes(l))
    .sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0) || String(b.created_at).localeCompare(String(a.created_at)));
  const notes = state.notes.filter((n) => [n.title, n.summary, n.transcription].join("\n").toLowerCase().includes(l));
  const comments = searchComments(query);
  if (!tasks.length && !notes.length && !comments.length) return emptyState("Niets gevonden", "Probeer een ander woord.");
  let html = "";
  if (tasks.length) {
    html += `<section class="group"><div class="group-head"><h2>Taken</h2><span class="count">${tasks.length}</span></div>
      <div class="card">${taskList(tasks.slice(0, 50), { showProject: true, query })}</div></section>`;
  }
  if (notes.length) {
    html += `<section class="group"><div class="group-head"><h2>Notities</h2><span class="count">${notes.length}</span></div>
      <div class="card list-card">${notes.slice(0, 30).map((n) => {
        const where = [n.title, n.summary].some((x) => String(x || "").toLowerCase().includes(l)) ? n.summary : n.transcription;
        return `<button type="button" class="note-hit" data-act="open-note" data-id="${n.id}">
          <span class="label-tag" style="--c:${labelColor(n.label)}">${escapeHtml(labelName(n.label))}</span>
          <b>${highlight(n.title || "Spraaknotitie", query)}</b>
          <span>${highlight(snippet(where || n.transcription, query), query)}</span>
        </button>`;
      }).join("")}</div></section>`;
  }
  if (comments.length) {
    html += `<section class="group"><div class="group-head"><h2>Opmerkingen</h2><span class="count">${comments.length}</span></div>
      <div class="card list-card">${comments.slice(0, 30).map((c) => `<button type="button" class="note-hit" data-act="open-task" data-id="${c.task.id}">
          <b>${escapeHtml(c.task.title)}</b>
          <span>${highlight(snippet(c.body, query), query)}</span>
        </button>`).join("")}</div></section>`;
  }
  return html;
}

export default {
  tab: null,
  topbar: () => ({
    search: true,
    back: true,
    html: `<div class="search topsearch ${q ? "has-value" : ""}">
      <svg class="icon-sm"><use href="#i-search"/></svg>
      <input type="search" id="global-search" placeholder="Zoeken" autocomplete="off" enterkeyhint="search" value="${escapeHtml(q)}" aria-label="Zoeken in taken en notities">
      <button type="button" class="icon-btn search-clear" data-act="clear" aria-label="Zoekopdracht wissen"><svg class="icon-sm"><use href="#i-x"/></svg></button>
    </div>`,
  }),
  hideFab: true,
  render() { return `<div id="search-results">${results()}</div>`; },
  after(root, params, { first }) {
    rootEl = root;
    if (first) {
      const input = document.getElementById("global-search");
      if (input) input.focus({ preventScroll: true });
      // Opmerkingen pas laden als je gaat zoeken (één query).
      loadCommentIndex().then((ok) => {
        const el = document.getElementById("search-results");
        if (ok && el && q.trim()) el.innerHTML = results();
      });
    }
  },
  update(root) {
    const el = root.querySelector("#search-results");
    if (el) el.innerHTML = results();
    return true;
  },
  onInput(e) {
    if (e.target.id !== "global-search") return;
    q = e.target.value;
    e.target.closest(".search").classList.toggle("has-value", !!q);
    clearTimeout(this._t);
    this._t = setTimeout(() => { const el = document.getElementById("search-results"); if (el) el.innerHTML = results(); }, 100);
  },
  onClick(act, el) {
    if (act === "clear") {
      q = "";
      const input = document.getElementById("global-search");
      input.value = "";
      input.closest(".search").classList.remove("has-value");
      document.getElementById("search-results").innerHTML = results();
      input.focus();
    }
    if (act === "open-note") actions.openNote(el.dataset.id);
    if (act === "open-task") actions.openTask(el.dataset.id);
  },
};
