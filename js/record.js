// Spraaknotities opnemen op de telefoon. De opname gaat naar Supabase
// (bucket "audio", map phone/) met een rij in "recordings". De pc van Dion
// pakt rijen met status "wachtend" op, transcribeert ze en maakt er een
// notitie (en via een trigger taken) van. Staat de pc uit, dan wacht de
// opname gewoon tot hij weer aangaat.

import { openSheet, escapeHtml, icon, toast, haptic, reducedMotion, uuid, confirmSheet } from "./ui.js";
import { sb, state, emit, projectById, activeProjects, loadAll, noteById, loadPcStatus, pcState, agoText } from "./store.js";
import { projectSheet } from "./pickers.js";

const MAX_SEC = 600;
const PENDING = ["wachtend", "bezig", "mislukt"];

// Opnames die niet geüpload konden worden blijven in het geheugen staan,
// zodat je het opnieuw kunt proberen zonder opnieuw in te spreken.
export const failedUploads = [];

function pickMime() {
  if (!window.MediaRecorder) return null;
  const opts = [["audio/webm;codecs=opus", "webm"], ["audio/webm", "webm"], ["audio/mp4", "m4a"], ["audio/aac", "m4a"]];
  for (const [m, ext] of opts) {
    try { if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext }; } catch {}
  }
  return { mime: "", ext: "webm" };
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function openRecorder({ project_id = null } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast("Opnemen werkt niet in deze browser.");
    return;
  }
  let projectId = project_id;
  let stream = null, rec = null, chunks = [], ctx = null, raf = 0, startAt = 0, elapsed = 0, timer = 0;
  let mime = pickMime();
  let phase = "start"; // start | rec | saving | error
  let saved = false;

  const sh = openSheet({
    label: "Spraaknotitie opnemen",
    className: "recorder",
    html: `
      <p class="sheet-title">Spraaknotitie</p>
      <p class="sheet-sub rec-status" aria-live="polite">Microfoon aanzetten…</p>
      <div class="rec-visual" aria-hidden="true">
        <svg viewBox="0 0 200 200" class="rec-rings">
          <circle class="r3" cx="100" cy="100" r="84"/>
          <circle class="r2" cx="100" cy="100" r="60"/>
          <circle class="r1" cx="100" cy="100" r="36"/>
          <circle class="core" cx="100" cy="100" r="10"/>
        </svg>
      </div>
      <p class="rec-time" role="timer" aria-label="Opnameduur">0:00</p>
      <div class="rec-project"><button type="button" class="chip" data-a="project"></button></div>
      <div class="sheet-actions">
        <button type="button" class="btn-cancel" data-a="cancel">Annuleren</button>
        <button type="button" class="btn-ok rec-stop" data-a="save" disabled>${icon("stop", "icon-sm")}Opslaan</button>
      </div>`,
    onClose: () => { cleanup(); },
  });

  const status = sh.q(".rec-status");
  const timeEl = sh.q(".rec-time");
  const saveBtn = sh.q('[data-a="save"]');
  const rings = [sh.q(".r1"), sh.q(".r2"), sh.q(".r3")];

  function renderProject() {
    const p = projectId ? projectById(projectId) : null;
    sh.q('[data-a="project"]').innerHTML = p
      ? `<span class="dot" style="--c:${escapeHtml(p.color)}"></span>Project: ${escapeHtml(p.name)}`
      : `${icon("inbox", "icon-sm")}Project: Inbox`;
  }
  renderProject();

  function cleanup() {
    cancelAnimationFrame(raf);
    clearInterval(timer);
    if (rec && rec.state !== "inactive") { try { rec.onstop = null; rec.stop(); } catch {} }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      phase = "error";
      sh.el.classList.add("is-error");
      status.textContent = e && (e.name === "NotAllowedError" || e.name === "SecurityError")
        ? "Nota mag de microfoon niet gebruiken. Sta de microfoon toe in je browserinstellingen en probeer opnieuw."
        : e && e.name === "NotFoundError" ? "Geen microfoon gevonden." : "De microfoon starten lukte niet.";
      saveBtn.hidden = true;
      return;
    }
    if (sh.closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    try { rec = new MediaRecorder(stream, mime.mime ? { mimeType: mime.mime } : undefined); }
    catch { rec = new MediaRecorder(stream); mime = { mime: rec.mimeType || "", ext: /mp4|aac/.test(rec.mimeType) ? "m4a" : "webm" }; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(1000);
    phase = "rec";
    haptic();
    startAt = Date.now();
    sh.el.classList.add("is-rec");
    status.textContent = "Neemt op";
    saveBtn.disabled = false;
    timer = setInterval(() => {
      elapsed = (Date.now() - startAt) / 1000;
      timeEl.textContent = fmt(elapsed);
      if (elapsed >= MAX_SEC) { toast("Maximaal 10 minuten. De opname is gestopt."); save(); }
    }, 250);
    meter();
  }

  // Niveaumeter: de ringen uit het logo bewegen mee met je stem.
  function meter() {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let level = 0;
      const still = reducedMotion();
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        level = level * 0.75 + rms * 0.25;
        rings.forEach((r, i) => {
          if (still) r.style.opacity = String(0.35 + level * 0.65);
          else {
            r.style.transform = `scale(${1 + level * (0.12 + i * 0.1)})`;
            r.style.opacity = String(Math.max(0.25, 1 - i * 0.25 - (1 - level) * 0.3));
          }
        });
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* geen meter, opnemen werkt gewoon */ }
  }

  function save() {
    if (phase !== "rec") return;
    phase = "saving";
    clearInterval(timer);
    cancelAnimationFrame(raf);
    const duration = Math.max(1, Math.round((Date.now() - startAt) / 1000));
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<svg class="icon-sm spin"><use href="#i-rings"/></svg>Opslaan`;
    status.textContent = "Opslaan…";
    sh.el.classList.remove("is-rec");
    rec.onstop = async () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const type = (mime.mime || rec.mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(chunks, { type });
      const label = projectId ? projectById(projectId)?.name || null : null;
      const item = { id: uuid(), blob, type, ext: mime.ext, duration, label, at: new Date().toISOString() };
      saved = true;
      sh.close();
      await upload(item);
    };
    try { rec.requestData(); } catch {}
    rec.stop();
  }

  sh.el.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]");
    if (!a) return;
    if (a.dataset.a === "cancel") {
      if (phase === "rec" && (Date.now() - startAt) > 3000) {
        const ok = await confirmSheet({ title: "Opname weggooien?", text: "Wat je hebt ingesproken wordt niet bewaard.", ok: "Weggooien" });
        if (!ok) return;
      }
      sh.close();
    }
    if (a.dataset.a === "save") save();
    if (a.dataset.a === "project") {
      const r = await projectSheet({ project_id: projectId, sections: false, title: "Project voor deze notitie" });
      if (r) { projectId = r.project_id; renderProject(); }
    }
  });

  start();
  return sh;
}

export async function upload(item) {
  const path = `phone/${item.id}.${item.ext}`;
  const up = await sb.storage.from("audio").upload(path, item.blob, { contentType: item.type, upsert: true });
  let err = up.error;
  let row = null;
  if (!err) {
    const ins = await sb.from("recordings").insert({
      audio_path: path, mime_type: item.type, duration_sec: item.duration, label: item.label, recorded_at: item.at,
    }).select().single();
    err = ins.error;
    row = ins.data;
  }
  const i = failedUploads.indexOf(item);
  if (err) {
    console.warn("Upload mislukt:", err);
    if (i < 0) failedUploads.unshift(item);
    emit("status");
    toast("Uploaden mislukt. Je opname staat klaar om opnieuw te proberen.", {
      action: { label: "Opnieuw proberen", fn: () => upload(item) },
    });
    return false;
  }
  if (i >= 0) failedUploads.splice(i, 1);
  if (row) state.recordings = [row, ...state.recordings.filter((r) => r.id !== row.id)];
  emit("status");
  toast(pcState() === "online"
    ? "Opname opgeslagen. Je computer verwerkt hem zo."
    : "Opname opgeslagen. Je computer verwerkt hem zodra hij aanstaat.");
  startPolling();
  return true;
}

export function discardFailed(id) {
  const i = failedUploads.findIndex((x) => x.id === id);
  if (i >= 0) failedUploads.splice(i, 1);
  emit("status");
}

export async function deleteRecording(id) {
  const r = state.recordings.find((x) => x.id === id);
  if (!r) return;
  state.recordings = state.recordings.filter((x) => x.id !== id);
  emit("status");
  const { error } = await sb.from("recordings").delete().eq("id", id);
  if (error) { state.recordings.push(r); emit("status"); toast("Verwijderen mislukt."); return; }
  if (r.audio_path) await sb.storage.from("audio").remove([r.audio_path]);
  toast("Opname verwijderd");
}

export async function loadRecordings() {
  loadPcStatus();
  const { data, error } = await sb.from("recordings").select("*").in("status", PENDING).order("recorded_at", { ascending: false });
  if (error) return; // tabel (nog) niet bereikbaar: geen kaartjes
  state.recordings = data || [];
  emit("status");
  startPolling();
}

// ---------- Status volgen ----------
// Elke 10 s kijken zolang er iets wacht of bezig is en de app zichtbaar is.
let pollTimer = 0;
export function startPolling() {
  clearTimeout(pollTimer);
  const active = state.recordings.some((r) => r.status === "wachtend" || r.status === "bezig");
  if (!active) return;
  pollTimer = setTimeout(poll, 10000);
}

async function poll() {
  if (document.hidden) { pollTimer = setTimeout(poll, 10000); return; }
  const ids = state.recordings.filter((r) => r.status === "wachtend" || r.status === "bezig").map((r) => r.id);
  if (!ids.length) return;
  loadPcStatus();
  const { data, error } = await sb.from("recordings").select("*").in("id", ids);
  if (error) { startPolling(); return; }
  const done = [];
  for (const row of data || []) {
    const cur = state.recordings.find((r) => r.id === row.id);
    if (!cur) continue;
    if (row.status === "klaar") done.push(row);
    else Object.assign(cur, row);
  }
  // Verdwenen rijen (bijv. op de pc opgeruimd) ook weghalen.
  const seen = new Set((data || []).map((r) => r.id));
  state.recordings = state.recordings.filter((r) => (seen.has(r.id) || !ids.includes(r.id)) && !done.some((d) => d.id === r.id));
  if (done.length) {
    await loadAll();
    for (const d of done) {
      const note = d.note_id != null ? noteById(d.note_id) : null;
      toast(`Notitie verwerkt: ${note?.title || "nieuwe notitie"}`);
    }
  }
  emit("status");
  startPolling();
}

// ---------- Computer aan/uit ----------
// Elke 30 s de status ophalen zolang Notities (of Instellingen) open is en
// de app zichtbaar is.
let statusTimer = 0;
let statusOn = false;
let statusAt = 0;
export function watchPcStatus(on) {
  clearTimeout(statusTimer);
  const was = statusOn;
  statusOn = on;
  if (!on) return;
  // Net al opgehaald (bijv. bij het opstarten): alleen de volgende plannen.
  if (was || Date.now() - statusAt < 5000) scheduleStatus(); else statusTick();
}
function scheduleStatus() {
  clearTimeout(statusTimer);
  if (statusOn) statusTimer = setTimeout(statusTick, 30000);
}
async function statusTick() {
  if (!document.hidden) { statusAt = Date.now(); await loadPcStatus(); }
  scheduleStatus();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && statusOn) statusTick();
});

export function pcStatusText(st = pcState()) {
  if (st === "online") return "Computer staat aan";
  if (st === "offline") {
    const ago = agoText(state.pcStatus.last_seen);
    return "Computer staat uit" + (ago ? " · laatst gezien " + ago : "");
  }
  if (st === "missing") return "Computer nog niet verbonden";
  return "";
}

export function pcStatusLine() {
  const st = pcState();
  if (!st) return "";
  return `<p class="pc-line is-${st}" role="status"><span class="pc-dot" aria-hidden="true"></span>${escapeHtml(pcStatusText(st))}</p>`;
}

export function pendingCards() {
  const cards = [];
  for (const f of failedUploads) {
    cards.push(`
      <div class="card pending is-failed" data-failed="${f.id}">
        <span class="pending-ic">${icon("alert")}</span>
        <div class="grow"><b>Niet geüpload</b><span>${fmt(f.duration)} · ${escapeHtml(f.label || "Inbox")}</span></div>
        <button type="button" class="btn-small" data-act="rec-retry" data-id="${f.id}">Opnieuw proberen</button>
        <button type="button" class="icon-btn sm" data-act="rec-discard" data-id="${f.id}" aria-label="Opname weggooien">${icon("x", "icon-sm")}</button>
      </div>`);
  }
  for (const r of state.recordings) {
    if (!PENDING.includes(r.status)) continue;
    const when = new Date(r.recorded_at || r.created_at);
    const whenText = isNaN(when) ? "" : when.toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const meta = `${fmt(r.duration_sec || 0)} · ${escapeHtml(r.label || "Inbox")}${whenText ? " · " + whenText : ""}`;
    if (r.status === "mislukt") {
      cards.push(`
        <div class="card pending is-failed">
          <span class="pending-ic">${icon("alert")}</span>
          <div class="grow"><b>Mislukt${r.error ? ": " + escapeHtml(r.error) : ""}</b><span>${meta}</span></div>
          <button type="button" class="icon-btn sm" data-act="rec-delete" data-id="${r.id}" aria-label="Opname verwijderen">${icon("trash", "icon-sm")}</button>
        </div>`);
    } else {
      const busy = r.status === "bezig";
      const pc = pcState();
      const waitText = pc === "online" ? "Wordt zo opgepakt" : pc === "offline" ? "Wacht op je computer (staat uit)" : "Wacht op je computer";
      cards.push(`
        <div class="card pending ${busy ? "is-busy" : ""}">
          <span class="pending-ic">${busy ? `<svg class="icon spin"><use href="#i-rings"/></svg>` : icon("clock")}</span>
          <div class="grow"><b>${busy ? "Wordt verwerkt…" : waitText}</b><span>${meta}</span></div>
        </div>`);
    }
  }
  return cards.length ? `<div class="pending-list">${cards.join("")}</div>` : "";
}

export async function handlePendingAction(act, id) {
  if (act === "rec-retry") { const f = failedUploads.find((x) => x.id === id); if (f) upload(f); }
  if (act === "rec-discard") {
    const ok = await confirmSheet({ title: "Opname weggooien?", text: "Deze opname is nog niet geüpload en gaat verloren.", ok: "Weggooien" });
    if (ok) discardFailed(id);
  }
  if (act === "rec-delete") {
    const ok = await confirmSheet({ title: "Opname verwijderen?", text: "De mislukte opname en het audiobestand worden verwijderd." });
    if (ok) deleteRecording(id);
  }
}
