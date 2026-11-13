// Bordweergave van een project: een kolom per sectie, kaarten slepen
// tussen en binnen kolommen (lang indrukken, dan bewegen).

import { escapeHtml, icon, haptic, reducedMotion, actions } from "../ui.js";
import { allTasks, sectionsOf, getTask, updateTask, updateTasks, childrenOf, nextSortOrder } from "../store.js";
import { taskRow, sortTasks } from "../tasks.js";
import { addInline } from "./common.js";

const HOLD_MS = 350;
const EDGE = 44;

function columnTasks(pid, sid, sort, showDone) {
  const list = allTasks().filter((t) => t.project_id === pid && (t.section_id || null) === sid && !t.parent_id);
  const open = sortTasks(list.filter((t) => !t.completed), sort);
  const done = showDone ? list.filter((t) => t.completed).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))) : [];
  return { open, done };
}

function column({ pid, sid, name, menu, sort, showDone }) {
  const { open, done } = columnTasks(pid, sid, sort, showDone);
  const cards = [...open, ...done].map((t) => taskRow(t, { hideSubCount: false })).join("");
  return `
    <section class="board-col" data-col="${sid || ""}" aria-label="${escapeHtml(name)}">
      <div class="board-col-head">
        <h2>${escapeHtml(name)}</h2><span class="count">${open.length || ""}</span>
        <span class="grow"></span>
        ${menu ? `<button type="button" class="icon-btn sm" data-act="section-menu" data-id="${sid}" aria-label="Opties voor sectie ${escapeHtml(name)}">${icon("more", "icon-sm")}</button>` : ""}
      </div>
      <div class="board-col-body">
        <ul class="task-list board-list" data-section="${sid || ""}">${cards}</ul>
        ${addInline(`data-project="${pid}" data-section="${sid || ""}"`)}
      </div>
    </section>`;
}

export function renderBoard(pid, { sort = "manual", showDone = false } = {}) {
  const sections = sectionsOf(pid);
  const loose = allTasks().some((t) => t.project_id === pid && !t.section_id && !t.parent_id && (showDone || !t.completed));
  let cols = "";
  if (loose || !sections.length) cols += column({ pid, sid: null, name: "Geen sectie", menu: false, sort, showDone });
  for (const s of sections) cols += column({ pid, sid: s.id, name: s.name, menu: true, sort, showDone });
  cols += `<section class="board-col board-add-col"><button type="button" class="add-section" data-act="add-section">${icon("plus", "icon-sm")}Sectie toevoegen</button></section>`;
  return `<div class="board" data-board="${pid}" data-no-gestures>${cols}</div>
    <p class="footnote board-hint">Houd een kaart ingedrukt om hem te verplaatsen.</p>`;
}

// ---------- Scrollpositie bewaren tussen renders ----------
const scrollMem = new Map(); // pid -> { left, cols: {sid: top} }

function remember(board) {
  const pid = board.dataset.board;
  const cols = {};
  board.querySelectorAll(".board-col-body").forEach((b) => { cols[b.parentElement.dataset.col] = b.scrollTop; });
  scrollMem.set(pid, { left: board.scrollLeft, cols });
}

export function afterBoard(root) {
  const board = root.querySelector(".board");
  if (!board) return;
  const mem = scrollMem.get(board.dataset.board);
  if (mem) {
    board.scrollLeft = mem.left;
    board.querySelectorAll(".board-col-body").forEach((b) => { const t = mem.cols[b.parentElement.dataset.col]; if (t) b.scrollTop = t; });
  }
  board.addEventListener("scroll", () => remember(board), { passive: true });
  board.querySelectorAll(".board-col-body").forEach((b) => b.addEventListener("scroll", () => remember(board), { passive: true }));
}

// ---------- Slepen ----------
let drag = null;   // { li, ghost, ph, board, ... }
let press = null;  // lopende long-press
let suppressClick = false;
let bound = false;

export function isBoardDragging() { return !!drag; }

export function bindBoard(root) {
  if (bound) return;
  bound = true;

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    const li = e.target.closest(".board li.task");
    if (!li || e.target.closest(".check") || li.classList.contains("completing")) return;
    press = { li, id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY };
    press.timer = setTimeout(() => { if (press) startDrag(press.x, press.y); }, HOLD_MS);
  });

  window.addEventListener("pointermove", (e) => {
    if (drag && e.pointerId === drag.pointer) { e.preventDefault(); drag.x = e.clientX; drag.y = e.clientY; moveDrag(); return; }
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    const dist = Math.hypot(dx, dy);
    // Muis: meteen slepen bij bewegen. Vinger: bewegen = scrollen.
    if (press.type === "mouse" && dist > 6) { const { x, y } = press; startDrag(x, y); if (drag) { drag.x = e.clientX; drag.y = e.clientY; moveDrag(); } }
    else if (press.type !== "mouse" && dist > 8) cancelPress();
  }, { passive: false });

  window.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.pointer) { finish(true); return; }
    if (press && e.pointerId === press.id) cancelPress();
  });
  window.addEventListener("pointercancel", (e) => {
    if (drag) return; // slepen loopt door via de touchmove-blokkade
    if (press && e.pointerId === press.id) cancelPress();
  });
  // Tijdens slepen niet scrollen en geen trek-om-te-vernieuwen.
  root.addEventListener("touchmove", (e) => { if (drag) { e.preventDefault(); e.stopPropagation(); } }, { passive: false });
  root.addEventListener("touchend", (e) => { if (drag) { e.stopPropagation(); finish(true); } });
  window.addEventListener("keydown", (e) => { if (drag && e.key === "Escape") { e.preventDefault(); finish(false); } });
  window.addEventListener("click", (e) => {
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; }
  }, true);
}

function cancelPress() { if (press) clearTimeout(press.timer); press = null; }

function startDrag(x, y) {
  const { li, id } = press;
  cancelPress();
  const board = li.closest(".board");
  if (!board || !document.contains(li)) return;
  haptic();
  const r = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add("board-ghost");
  ghost.removeAttribute("data-task-id");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { width: r.width + "px", height: r.height + "px", left: r.left + "px", top: r.top + "px" });
  document.body.appendChild(ghost);
  li.classList.add("board-ph");
  li.style.height = r.height + "px";
  drag = {
    li, ghost, board, pointer: id, x, y, offX: x - r.left, offY: y - r.top,
    from: { list: li.parentElement, next: li.nextElementSibling },
    task: getTask(li.dataset.taskId),
  };
  document.body.classList.add("is-dragging", "board-dragging");
  moveDrag();
  drag.raf = requestAnimationFrame(autoScroll);
}

function moveDrag() {
  const d = drag;
  if (!d) return;
  d.ghost.style.transform = `translate(${d.x - d.offX - parseFloat(d.ghost.style.left)}px, ${d.y - d.offY - parseFloat(d.ghost.style.top)}px)${reducedMotion() ? "" : " rotate(1.5deg)"}`;
  // Doelkolom: de kolom waar de vinger boven is (of de dichtstbijzijnde).
  const cols = [...d.board.querySelectorAll(".board-col:not(.board-add-col)")];
  let col = cols.find((c) => { const r = c.getBoundingClientRect(); return d.x >= r.left && d.x <= r.right; });
  if (!col) {
    let best = Infinity;
    cols.forEach((c) => { const r = c.getBoundingClientRect(); const dist = Math.min(Math.abs(d.x - r.left), Math.abs(d.x - r.right)); if (dist < best) { best = dist; col = c; } });
  }
  if (!col) return;
  d.col = col;
  const list = col.querySelector(".board-list");
  // Alleen tussen de open kaarten; voltooide blijven onderaan.
  const cards = [...list.children].filter((c) => c !== d.li && !c.classList.contains("done"));
  let before = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (d.y < r.top + r.height / 2) { before = c; break; }
  }
  if (!before) before = [...list.children].find((c) => c !== d.li && c.classList.contains("done")) || null;
  if (d.li.parentElement !== list || d.li.nextElementSibling !== before) list.insertBefore(d.li, before);
}

function autoScroll() {
  const d = drag;
  if (!d) return;
  const br = d.board.getBoundingClientRect();
  let sx = 0;
  if (d.x < br.left + EDGE) sx = -Math.ceil((br.left + EDGE - d.x) / 3);
  else if (d.x > br.right - EDGE) sx = Math.ceil((d.x - (br.right - EDGE)) / 3);
  // Scroll-snap tijdens slepen uit, anders springt het bord terug.
  if (sx) d.board.scrollLeft += sx;
  let sy = 0;
  const body = d.col && d.col.querySelector(".board-col-body");
  if (body) {
    const r = body.getBoundingClientRect();
    if (d.y < r.top + EDGE) sy = -Math.ceil((r.top + EDGE - d.y) / 3);
    else if (d.y > r.bottom - EDGE) sy = Math.ceil((d.y - (r.bottom - EDGE)) / 3);
    if (sy) body.scrollTop += sy;
  }
  if (sx || sy) moveDrag();
  d.raf = requestAnimationFrame(autoScroll);
}

function descendantIds(id) {
  const out = [];
  const walk = (pid) => childrenOf(pid).forEach((c) => { out.push(c.id); walk(c.id); });
  walk(id);
  return out;
}

function finish(commit) {
  const d = drag;
  if (!d) return;
  drag = null;
  cancelAnimationFrame(d.raf);
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);
  document.body.classList.remove("is-dragging", "board-dragging");
  d.ghost.remove();
  d.li.classList.remove("board-ph");
  d.li.style.height = "";
  const t = d.task;
  const list = d.li.parentElement;
  if (!commit || !t || !list) {
    d.from.list.insertBefore(d.li, d.from.next && d.from.next.parentElement === d.from.list ? d.from.next : null);
    actions.rerender();
    return;
  }
  const sid = list.dataset.section || null;
  const open = [...list.children].filter((c) => !c.classList.contains("done"));
  const i = open.indexOf(d.li);
  const prev = i > 0 ? getTask(open[i - 1].dataset.taskId) : null;
  const next = i >= 0 && i < open.length - 1 ? getTask(open[i + 1].dataset.taskId) : null;
  const sameSection = (t.section_id || null) === sid;
  const unchanged = sameSection && d.from.list === list && (d.from.next === d.li.nextElementSibling);
  if (unchanged) { actions.rerender(); return; }
  let so;
  if (prev && next) so = ((prev.sort_order ?? 0) + (next.sort_order ?? 0)) / 2;
  else if (prev) so = (prev.sort_order ?? 0) + 1;
  else if (next) so = (next.sort_order ?? 0) - 1;
  else so = nextSortOrder(allTasks().filter((x) => x.id !== t.id && x.project_id === t.project_id && (x.section_id || null) === sid && !x.parent_id));
  const patch = { sort_order: so };
  if (!sameSection) patch.section_id = sid;
  updateTask(t.id, patch);
  if (!sameSection) {
    const kids = descendantIds(t.id);
    if (kids.length) updateTasks(kids, { section_id: sid });
  }
  actions.rerender();
}
