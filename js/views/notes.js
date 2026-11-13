// Notities: de spraaknotities van de pc, met speler, golfvorm, transcriptie
// en de actiepunten (als echte taken, zie tasksForNote).

import { formatDue } from "../parse.js";
import { escapeHtml, highlight, icon, toast, CHECK_SVG, downloadBlob, csvField, openSheet, confirmSheet, actions, haptic, menuSheet } from "../ui.js";
import {
  state, labelColor, labelName, TODO_CATEGORIES, deleteNote, setNoteActionItems, noteById,
} from "../store.js";
import { pendingCards, handlePendingAction, pcStatusLine, watchPcStatus } from "../record.js";

let activeLabel = "";
let query = "";
let sort = "newest";
let lastNotes = null;
let rootEl = null;

// ---------- Hulpjes ----------
function noteDate(note) {
  const d = new Date(note.note_timestamp || note.created_at);
  return isNaN(d) ? null : d;
}

function formatDisplayTime(value) {
  if (!value) return "onbekende tijd";
  const d = new Date(value);
  if (isNaN(d)) return value;
  return d.toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatClock(d) { return d ? d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : ""; }
function dayKey(d) { return d ? d.toDateString() : "onbekend"; }

function dayLabel(d) {
  if (!d) return "Onbekende datum";
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Vandaag";
  if (d.toDateString() === yesterday.toDateString()) return "Gisteren";
  const opts = { weekday: "long", day: "numeric", month: "long" };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  const s = d.toLocaleDateString("nl-NL", opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatTotalDuration(totalSeconds) {
  if (!totalSeconds) return null;
  if (totalSeconds < 60) return "minder dan een minuut";
  const min = Math.round(totalSeconds / 60);
  return `${min} ${min === 1 ? "minuut" : "minuten"}`;
}

function noteTxtHeader(note) {
  return `[${note.label || "geen label"}] ${formatDisplayTime(note.note_timestamp || note.created_at)} (${note.duration_sec || "?"}s)`;
}

export function exportNotes(kind, notes) {
  if (kind === "txt") {
    const lines = [];
    for (const note of notes) lines.push(noteTxtHeader(note), note.transcription || "", "");
    downloadBlob(lines.join("\n"), "nota-export.txt", "text/plain");
  } else {
    const rows = [["label", "tijdstip", "duur_sec", "titel", "samenvatting", "transcriptie"]];
    for (const note of notes) {
      rows.push([note.label || "", formatDisplayTime(note.note_timestamp || note.created_at),
        note.duration_sec || "", note.title || "", note.summary || "", note.transcription || ""]);
    }
    downloadBlob("﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n"), "nota-export.csv", "text/csv");
  }
}

// ---------- Filteren / sorteren ----------
// Taken per notitie, één keer per weergave opgebouwd (i.p.v. per notitie
// door alle taken te lopen). Elke ingang (render/update/...) zet hem op null.
let byNote = null;
function noteTasks(id) {
  if (!byNote) {
    byNote = new Map();
    for (const t of state.tasks.values()) {
      if (t.note_id == null) continue;
      const k = String(t.note_id);
      if (!byNote.has(k)) byNote.set(k, []);
      byNote.get(k).push(t);
    }
    for (const l of byNote.values()) l.sort((a, b) => (a.note_item_index ?? 0) - (b.note_item_index ?? 0));
  }
  return byNote.get(String(id)) || [];
}

function itemsOf(note) {
  const tasks = noteTasks(note.id);
  if (tasks.length) return tasks.map((t) => ({ task: t, text: t.title, done: t.completed }));
  // Oude notitie zonder gekoppelde taken: val terug op de JSON.
  return (note.actionItems || []).map((i, index) => ({ json: index, text: i.text, done: i.done }));
}

function getFilteredSortedNotes() {
  byNote = null;
  const q = query.trim().toLowerCase();
  const filtered = state.notes.filter((note) => {
    if (activeLabel && note.label !== activeLabel) return false;
    if (q) {
      const hay = [note.transcription, note.title, note.summary, ...itemsOf(note).map((i) => i.text)].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => {
    if (sort === "oldest") return a.id - b.id;
    if (sort === "longest") return (b.duration_sec || 0) - (a.duration_sec || 0);
    if (sort === "shortest") return (a.duration_sec || 0) - (b.duration_sec || 0);
    return b.id - a.id;
  });
  return filtered;
}

function labelChips() {
  const counts = {};
  state.notes.forEach((n) => { if (n.label) counts[n.label] = (counts[n.label] || 0) + 1; });
  const labels = Object.keys(counts).sort((a, b) => {
    const ia = TODO_CATEGORIES.indexOf(a), ib = TODO_CATEGORIES.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  if (activeLabel && !counts[activeLabel]) activeLabel = "";
  if (!labels.length) return "";
  return `<button type="button" class="chip" data-act="label" data-label="" aria-pressed="${!activeLabel}">Alles</button>` +
    labels.map((l) => `
      <button type="button" class="chip" data-act="label" data-label="${escapeHtml(l)}" aria-pressed="${activeLabel === l}" style="--c:${labelColor(l)}">
        <span class="dot"></span>${escapeHtml(labelName(l))}<span class="n">${counts[l]}</span>
      </button>`).join("");
}

function introText() {
  const h = new Date().getHours();
  const greeting = h < 6 ? "Goedenacht" : h < 12 ? "Goedemorgen" : h < 18 ? "Goedemiddag" : "Goedenavond";
  const total = formatTotalDuration(state.notes.reduce((s, n) => s + (n.duration_sec || 0), 0));
  const n = state.notes.length;
  const sub = n === 0 ? "Nog geen notities." : `${n} ${n === 1 ? "notitie" : "notities"}${total ? `, samen ${total} opgenomen` : ""}.`;
  return { greeting, sub };
}

function itemsHtml(note) {
  const items = itemsOf(note);
  if (!items.length) return "";
  return items.map((it) => {
    if (it.task) {
      const t = it.task;
      const due = t.due_date ? formatDue(t.due_date, t.due_time, new Date()) : null;
      return `
        <li class="task note-item ${t.completed ? "done" : ""}" data-task-id="${t.id}">
          <div class="task-row">
            <button type="button" class="check prio-${t.priority || 4}" aria-pressed="${!!t.completed}" aria-label="${t.completed ? "Markeer als open" : "Afvinken"}: ${escapeHtml(t.title)}">${CHECK_SVG}</button>
            <span class="item-text">${highlight(t.title, query.trim())}${due && !t.completed ? ` <span class="meta-due tone-${due.tone}">${icon("calendar", "icon-xs")}${escapeHtml(due.text)}</span>` : ""}</span>
          </div>
        </li>`;
    }
    return `
      <li class="json-item ${it.done ? "done" : ""}">
        <button type="button" class="check" data-act="json-item" data-note-id="${note.id}" data-item-index="${it.json}" aria-pressed="${it.done}" aria-label="${it.done ? "Markeer als open" : "Afvinken"}">${CHECK_SVG}</button>
        <span class="item-text">${highlight(it.text, query.trim())}</span>
      </li>`;
  }).join("");
}

function listHtml() {
  const notes = getFilteredSortedNotes();
  const q = query.trim();
  if (notes.length === 0) {
    const filtered = q || activeLabel;
    return `
      <div class="card empty">
        <svg width="44" height="44"><use href="#i-rings"/></svg>
        <h3>${filtered ? "Niets gevonden" : "Nog geen notities"}</h3>
        <p>${filtered
          ? "Probeer een ander woord of een ander label."
          : "Neem een notitie op met je recorder of met de knop hierboven. Zodra je computer hem heeft verwerkt, verschijnt hij hier."}</p>
        ${filtered ? '<button type="button" class="btn-ghost" data-act="clear-filters">Filters wissen</button>' : ""}
      </div>`;
  }
  const byDate = sort === "newest" || sort === "oldest";
  let html = "";
  let lastDay = null;
  for (const note of notes) {
    const d = noteDate(note);
    if (byDate && dayKey(d) !== lastDay) {
      lastDay = dayKey(d);
      html += `<h3 class="day-label">${dayLabel(d)}</h3>`;
    }
    const metaWhen = byDate ? formatClock(d) : (d ? d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" }) : "");
    const items = itemsHtml(note);
    html += `
      <article class="card note" data-id="${note.id}">
        <div class="note-meta">
          <span class="label-tag" style="--c:${labelColor(note.label)}">${escapeHtml(labelName(note.label))}</span>
          <span>${metaWhen}</span>
          <span class="spacer"></span>
          <button type="button" class="icon-btn note-more" data-act="note-more" data-id="${note.id}" aria-label="Opties voor deze notitie">
            <svg class="icon"><use href="#i-more"/></svg>
          </button>
        </div>
        ${note.title ? `<h3 class="note-title">${highlight(note.title, q)}</h3>` : ""}
        ${note.summary ? `<p class="note-summary">${highlight(note.summary, q)}</p>` : ""}
        <ul class="items task-list" data-note-items="${note.id}" ${items ? "" : "hidden"}>${items}</ul>
        ${note.audioUrl ? `
        <div class="player" data-id="${note.id}">
          <button type="button" class="play" aria-label="Afspelen">
            <svg viewBox="0 0 44 44" aria-hidden="true">
              <circle class="ring-track" cx="22" cy="22" r="20" fill="none" stroke-width="2"/>
              <circle class="ring-progress" cx="22" cy="22" r="20" fill="none" stroke-width="2.5" stroke-linecap="round"
                stroke-dasharray="125.66" stroke-dashoffset="125.66"/>
              <circle cx="22" cy="22" r="14" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
              <path class="glyph-play" d="M19 16.5v11l9-5.5z" fill="currentColor"/>
              <g class="glyph-pause" fill="currentColor"><rect x="17.5" y="16.5" width="3" height="11" rx="1"/><rect x="23.5" y="16.5" width="3" height="11" rx="1"/></g>
            </svg>
          </button>
          <div class="wave" role="slider" aria-label="Afspeelpositie" aria-valuemin="0" aria-valuemax="${note.duration_sec || 0}" aria-valuenow="0" tabindex="0">
            ${waveBars(note)}
          </div>
          <span class="time">${formatTime(note.duration_sec || 0)}</span>
        </div>` : ""}
        ${note.transcription ? `
        <button type="button" class="transcript-toggle" data-act="transcript" aria-expanded="${q ? "true" : "false"}">
          Transcriptie <svg class="icon-sm"><use href="#i-chevron"/></svg>
        </button>
        <div class="transcript ${q ? "open" : ""}"><div><p>${highlight(note.transcription, q)}</p></div></div>` : ""}
      </article>`;
  }
  return html;
}

function renderList() {
  const list = rootEl && rootEl.querySelector("#notes-list");
  if (!list) return;
  byNote = null;
  stopPlayback();
  list.innerHTML = listHtml();
  watchWaves(list);
}

// ---------- Golfvorm & afspelen ----------
// Echte golfvorm uit de opname, berekend op de telefoon en daarna
// bewaard, zodat dat maar één keer per opname gebeurt.
const BAR_COUNT = 48;

function waveBars(note) {
  const peaks = cachedPeaks(note) || Array(BAR_COUNT).fill(0.18);
  return peaks.map((p) => `<i style="--h:${Math.round(Math.max(0.12, p) * 100)}%"></i>`).join("");
}

function cachedPeaks(note) {
  try {
    const raw = localStorage.getItem("nota-wave:" + note.audio_path);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Golfvormen pas berekenen als de speler in beeld komt, één tegelijk: anders
// downloadt en decodeert de telefoon bij het openen alle opnames tegelijk.
let waveObserver = null;
const waveQueue = [];
let waveBusy = false;
function watchWaves(root) {
  if (!("IntersectionObserver" in window)) { root.querySelectorAll(".player").forEach((p) => queueWave(p)); return; }
  if (!waveObserver) {
    waveObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { waveObserver.unobserve(e.target); queueWave(e.target); }
    }, { rootMargin: "300px 0px" });
  }
  root.querySelectorAll(".player").forEach((p) => {
    const note = noteById(p.dataset.id);
    if (note && note.audioUrl && !cachedPeaks(note)) waveObserver.observe(p);
  });
}
function queueWave(player) {
  if (!waveQueue.includes(player)) waveQueue.push(player);
  if (!waveBusy) nextWave();
}
async function nextWave() {
  const p = waveQueue.shift();
  if (!p) { waveBusy = false; return; }
  waveBusy = true;
  if (p.isConnected) await loadWaveform(p);
  nextWave();
}

let audioCtx = null;
async function loadWaveform(player) {
  const note = noteById(player.dataset.id);
  if (!note || !note.audioUrl || cachedPeaks(note)) return;
  try {
    const buf = await (await fetch(note.audioUrl)).arrayBuffer();
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const audio = await audioCtx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const block = Math.floor(data.length / BAR_COUNT);
    let peaks = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < block; j += 8) sum += Math.abs(data[i * block + j] || 0);
      peaks.push(sum / (block / 8));
    }
    const max = Math.max(...peaks) || 1;
    peaks = peaks.map((p) => +Math.pow(p / max, 0.8).toFixed(2));
    try { localStorage.setItem("nota-wave:" + note.audio_path, JSON.stringify(peaks)); } catch {}
    const wave = player.querySelector(".wave");
    if (wave && wave.isConnected) {
      wave.querySelectorAll("i").forEach((bar, i) =>
        bar.style.setProperty("--h", Math.round(Math.max(0.12, peaks[i]) * 100) + "%"));
    }
  } catch {
    // Geen golfvorm? Dan blijven de rustige standaardstreepjes staan.
  }
}

// Eén gedeelde audiospeler: er speelt altijd maar één notitie tegelijk.
const audio = new Audio();
audio.preload = "none";
let currentPlayer = null;
const RING = 125.66;

function updatePlayerUI() {
  if (!currentPlayer || !currentPlayer.isConnected) return;
  const dur = audio.duration || Number(currentPlayer.querySelector(".wave").getAttribute("aria-valuemax")) || 0;
  const pct = dur ? Math.min(1, audio.currentTime / dur) : 0;
  currentPlayer.querySelector(".ring-progress").style.strokeDashoffset = RING * (1 - pct);
  const bars = currentPlayer.querySelectorAll(".wave i");
  const on = Math.round(pct * bars.length);
  bars.forEach((b, i) => b.classList.toggle("on", i < on));
  currentPlayer.querySelector(".wave").setAttribute("aria-valuenow", Math.round(audio.currentTime));
  const remaining = dur - audio.currentTime;
  currentPlayer.querySelector(".time").textContent =
    currentPlayer.classList.contains("playing") || audio.currentTime > 0 ? formatTime(remaining) : formatTime(dur);
}

function resetPlayerUI(player) {
  if (!player || !player.isConnected) return;
  player.classList.remove("playing");
  player.querySelector(".ring-progress").style.strokeDashoffset = RING;
  player.querySelectorAll(".wave i").forEach((b) => b.classList.remove("on"));
  player.querySelector(".play").setAttribute("aria-label", "Afspelen");
  const note = noteById(player.dataset.id);
  player.querySelector(".time").textContent = formatTime(note ? note.duration_sec || 0 : 0);
}

export function stopPlayback() {
  audio.pause();
  if (currentPlayer) resetPlayerUI(currentPlayer);
  currentPlayer = null;
}

function startPlayer(player, seekPct) {
  const note = noteById(player.dataset.id);
  if (!note) return;
  if (currentPlayer !== player) {
    stopPlayback();
    currentPlayer = player;
    audio.src = note.audioUrl;
  }
  const go = () => {
    if (seekPct != null && audio.duration) audio.currentTime = seekPct * audio.duration;
    audio.play().catch(() => toast("Afspelen lukte niet."));
  };
  if (seekPct != null && !audio.duration) audio.addEventListener("loadedmetadata", go, { once: true });
  go();
  player.classList.add("playing");
  player.querySelector(".play").setAttribute("aria-label", "Pauzeren");
}

audio.addEventListener("timeupdate", updatePlayerUI);
audio.addEventListener("ended", () => {
  const p = currentPlayer;
  currentPlayer = null;
  resetPlayerUI(p);
});

// ---------- Notitie-opties ----------
function noteOptions(note) {
  const sh = openSheet({
    label: "Notitie-opties",
    html: `
      <p class="sheet-title">${escapeHtml(note.title || labelName(note.label))}</p>
      <p class="sheet-sub">${formatDisplayTime(note.note_timestamp || note.created_at)}, ${note.duration_sec || "?"} sec</p>
      <div class="sheet-group">
        ${note.transcription ? `<button type="button" class="sheet-item" data-a="copy">${icon("copy")}Transcriptie kopiëren</button>` : ""}
        <button type="button" class="sheet-item" data-a="export">${icon("file")}Transcriptie exporteren</button>
        ${note.audioUrl ? `<a class="sheet-item" data-a="audio" href="${escapeHtml(note.audioUrl)}" download>${icon("download")}Audio downloaden</a>` : ""}
      </div>
      <div class="sheet-group">
        <button type="button" class="sheet-item danger" data-a="delete">${icon("trash")}Verwijderen</button>
      </div>`,
  });
  sh.el.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]");
    if (!a) return;
    if (a.dataset.a === "copy") {
      try { await navigator.clipboard.writeText(note.transcription || ""); toast("Transcriptie gekopieerd"); }
      catch { toast("Kopiëren lukte niet."); }
      sh.close();
    }
    if (a.dataset.a === "export") {
      downloadBlob(`${noteTxtHeader(note)}\n${note.transcription || ""}\n`, `nota-${note.id}.txt`, "text/plain");
      sh.close();
    }
    if (a.dataset.a === "audio") setTimeout(() => sh.close(), 50);
    if (a.dataset.a === "delete") {
      sh.close();
      const ok = await confirmSheet({
        title: "Notitie verwijderen?",
        text: "De notitie en de opname worden definitief verwijderd. Dit kun je niet ongedaan maken. Taken die eruit kwamen blijven bestaan.",
      });
      if (!ok) return;
      if (currentPlayer && currentPlayer.dataset.id === String(note.id)) stopPlayback();
      if (await deleteNote(note)) toast("Notitie verwijderd");
    }
  });
}

// ---------- View ----------
function shell() {
  const { greeting, sub } = introText();
  return `
    <section class="intro notes-intro">
      <div class="grow"><h1>${greeting}</h1><p>${escapeHtml(sub)}</p></div>
      <button type="button" class="rec-btn" data-act="record">${icon("mic", "icon-sm")}Opnemen</button>
    </section>
    <div data-pc>${pcStatusLine()}</div>
    <div data-pending>${pendingCards()}</div>
    <div class="search-row">
      <div class="search ${query ? "has-value" : ""}" id="search">
        <svg class="icon-sm"><use href="#i-search"/></svg>
        <input type="search" id="notes-search" placeholder="Zoeken in notities" autocomplete="off" enterkeyhint="search" value="${escapeHtml(query)}" aria-label="Zoeken in notities">
        <button type="button" class="icon-btn search-clear" data-act="search-clear" aria-label="Zoekopdracht wissen">
          <svg class="icon-sm"><use href="#i-x"/></svg>
        </button>
      </div>
      <label class="sort">
        <span class="sr-only">Sorteren</span>
        <select id="sort-select">
          <option value="newest" ${sort === "newest" ? "selected" : ""}>Nieuwste</option>
          <option value="oldest" ${sort === "oldest" ? "selected" : ""}>Oudste</option>
          <option value="longest" ${sort === "longest" ? "selected" : ""}>Langste</option>
          <option value="shortest" ${sort === "shortest" ? "selected" : ""}>Kortste</option>
        </select>
        <svg class="icon-sm" style="width:14px;height:14px"><use href="#i-chevron"/></svg>
      </label>
    </div>
    <div class="chips" id="label-chips" role="group" aria-label="Notities filteren op label">${labelChips()}</div>
    <div id="notes-list">${listHtml()}</div>`;
}

export default {
  tab: "notities",
  topbar: () => ({ title: "Notities", actions: [{ act: "menu", icon: "more", label: "Meer" }] }),
  context: () => ({}),
  status: true, // toont opnames en pc-status
  render() {
    lastNotes = state.notes;
    byNote = null;
    stopPlayback();
    return shell();
  },
  after(root) {
    rootEl = root;
    waveQueue.length = 0;
    if (waveObserver) waveObserver.disconnect();
    watchWaves(root);
    watchPcStatus(true);
  },
  // Bij wijzigingen in taken alleen de actiepunten bijwerken, zodat een
  // spelende opname niet stopt. Alleen lijsten die echt veranderden.
  update(root) {
    if (state.notes !== lastNotes) return false;
    rootEl = root;
    byNote = null;
    root.querySelectorAll("[data-note-items]").forEach((ul) => {
      const note = noteById(ul.dataset.noteItems);
      if (!note) return;
      const html = itemsHtml(note);
      if (shown.get(ul) === html) return;
      shown.set(ul, html);
      ul.innerHTML = html;
      ul.hidden = !html;
    });
    setIfChanged(root.querySelector("[data-pending]"), pendingCards());
    setIfChanged(root.querySelector("[data-pc]"), pcStatusLine());
    return true;
  },
  async onClick(act, el, params, e) {
    if (act === "record") { actions.record({}); return; }
    if (act === "label") { activeLabel = el.dataset.label; rootEl.querySelector("#label-chips").innerHTML = labelChips(); renderList(); return; }
    if (act === "clear-filters") {
      activeLabel = ""; query = "";
      return "rerender";
    }
    if (act === "search-clear") {
      query = "";
      const input = rootEl.querySelector("#notes-search");
      input.value = "";
      rootEl.querySelector("#search").classList.remove("has-value");
      renderList();
      input.focus();
      return;
    }
    if (act === "transcript") {
      const open = el.getAttribute("aria-expanded") !== "true";
      el.setAttribute("aria-expanded", String(open));
      el.nextElementSibling.classList.toggle("open", open);
      return;
    }
    if (act === "note-more") { const n = noteById(el.dataset.id); if (n) noteOptions(n); return; }
    if (act === "json-item") return toggleJsonItem(el);
    if (act === "rec-retry" || act === "rec-delete" || act === "rec-discard") return handlePendingAction(act, el.dataset.id);
    if (act === "menu") {
      const r = await menuSheet({ groups: [
        { items: [{ id: "record", label: "Spraaknotitie opnemen", icon: "mic" }] },
        { label: "Exporteren", items: [
          { id: "txt", label: "Tekstbestand", icon: "download", hint: ".txt" },
          { id: "csv", label: "Spreadsheet", icon: "download", hint: ".csv" },
        ] },
        { items: [{ id: "refresh", label: "Vernieuwen", icon: "refresh" }] },
      ] });
      if (r === "record") actions.record({});
      if (r === "txt" || r === "csv") exportNotes(r, getFilteredSortedNotes());
      if (r === "refresh") return "refresh";
    }
  },
  onPlayClick(e) {
    const btn = e.target.closest(".play");
    if (!btn) return false;
    const player = btn.closest(".player");
    if (currentPlayer === player && !audio.paused) {
      audio.pause();
      player.classList.remove("playing");
      btn.setAttribute("aria-label", "Afspelen");
    } else {
      startPlayer(player);
    }
    return true;
  },
  // Zoeken in de opname door op de golfvorm te tikken of te slepen
  onPointerDown(e) {
    const wave = e.target.closest(".wave");
    if (!wave) return;
    const player = wave.closest(".player");
    const pctAt = (ev) => {
      const r = wave.getBoundingClientRect();
      return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    };
    startPlayer(player, pctAt(e));
    wave.setPointerCapture(e.pointerId);
    const move = (ev) => { if (audio.duration) { audio.currentTime = pctAt(ev) * audio.duration; updatePlayerUI(); } };
    const up = () => { wave.removeEventListener("pointermove", move); wave.removeEventListener("pointerup", up); };
    wave.addEventListener("pointermove", move);
    wave.addEventListener("pointerup", up);
  },
  onKeyDown(e) {
    const wave = e.target.closest(".wave");
    if (!wave || !currentPlayer || wave.closest(".player") !== currentPlayer) return;
    if (e.key === "ArrowRight") audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
  },
  onInput(e) {
    if (e.target.id === "notes-search") {
      query = e.target.value;
      rootEl.querySelector("#search").classList.toggle("has-value", !!query);
      clearTimeout(this._t);
      this._t = setTimeout(renderList, 120);
    }
  },
  onChange(e) {
    if (e.target.id === "sort-select") { sort = e.target.value; renderList(); }
  },
  leave() { stopPlayback(); watchPcStatus(false); },
};

// Laatst geschreven HTML per element, zodat update() niets vervangt dat
// gelijk bleef (dan blijft ook de opmaak van de rest staan).
const shown = new WeakMap();
function setIfChanged(el, html) {
  if (!el || shown.get(el) === html) return;
  if (shown.has(el) || el.innerHTML !== html) el.innerHTML = html;
  shown.set(el, html);
}

// Oude notitie zonder taken: actiepunt in de JSON afvinken.
async function toggleJsonItem(btn) {
  const note = noteById(btn.dataset.noteId);
  const index = Number(btn.dataset.itemIndex);
  if (!note || !note.actionItems[index]) return;
  const items = note.actionItems.map((i) => ({ ...i }));
  items[index].done = !items[index].done;
  haptic();
  btn.closest("li").classList.toggle("done", items[index].done);
  btn.setAttribute("aria-pressed", String(items[index].done));
  if (!await setNoteActionItems(note, items)) {
    btn.closest("li").classList.toggle("done", !items[index].done);
  }
}

// Naar een notitie springen (vanuit een taak "Uit notitie").
export function focusNote(id) {
  let card = document.querySelector(`.note[data-id="${id}"]`);
  if (!card && (activeLabel || query)) {
    activeLabel = ""; query = "";
    actions.rerender();
    card = document.querySelector(`.note[data-id="${id}"]`);
  }
  if (!card) { toast("Deze notitie bestaat niet meer."); return; }
  // Kaarten erboven echt opmaken (content-visibility), anders klopt de positie niet.
  const list = card.parentElement;
  list.classList.add("cv-off");
  setTimeout(() => list.classList.remove("cv-off"), 1200);
  card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
}
