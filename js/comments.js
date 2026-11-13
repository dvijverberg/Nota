// Opmerkingen en bijlagen bij taken. Eigen module, zodat detail.js,
// tasks.js en zoeken er alleen een paar functies van aanroepen.
//
// - Tellers (aantal opmerkingen, wel/geen bijlage) voor de taakrijen: één
//   lichte query per tabel na het laden, zonder de eerste weergave op te houden.
// - Per taak de opmerkingen met bijlagen, pas geladen als je de taak opent.
// - Versturen is optimistisch: eerst de bestanden naar Storage, dan de
//   opmerking, dan de bijlage-rijen. Lukt een stap niet, dan kun je het
//   opnieuw proberen en gaat het verder waar het bleef.

import { sb, state, subscribe, emit, getTask } from "./store.js";
import { escapeHtml, icon, highlight, toast, confirmSheet, menuSheet, openSheet, uuid } from "./ui.js";

const BUCKET = "attachments";
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 2000;
const URL_TTL = 3600;
const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

// ---------- Tellers voor de taakrijen ----------
const counts = new Map(); // taskId -> { c: opmerkingen, a: bijlagen }
let countsFor = null;

function bump(taskId, key, n) {
  const x = counts.get(taskId) || { c: 0, a: 0 };
  x[key] = Math.max(0, x[key] + n);
  counts.set(taskId, x);
}

// Elke keer dat de taken (opnieuw) geladen zijn, de tellers ophalen.
subscribe(() => {
  if (!state.loaded || state.tasks === countsFor) return;
  countsFor = state.tasks;
  loadCounts();
});

async function loadCounts() {
  const [c, a] = await Promise.all([
    sb.from("task_comments").select("task_id"),
    sb.from("task_attachments").select("task_id"),
  ]);
  if (c.error && a.error) return;
  for (const x of counts.values()) { if (!c.error) x.c = 0; if (!a.error) x.a = 0; }
  if (!c.error) (c.data || []).forEach((r) => bump(r.task_id, "c", 1));
  if (!a.error) (a.data || []).forEach((r) => bump(r.task_id, "a", 1));
  emit();
}

// Stukjes voor de meta-regel van een taakrij.
export function commentMeta(taskId) {
  const x = counts.get(taskId);
  if (!x) return [];
  const out = [];
  if (x.c) out.push(`<span class="meta-cmt" title="${x.c} ${x.c === 1 ? "opmerking" : "opmerkingen"}">${icon("comment", "icon-xs")}${x.c}</span>`);
  if (x.a) out.push(`<span class="meta-icon" title="Bijlagen">${icon("clip", "icon-xs")}</span>`);
  return out;
}

// ---------- Zoeken ----------
let index = null; // [{ id, task_id, body }]

export async function loadCommentIndex() {
  const { data, error } = await sb.from("task_comments").select("id, task_id, body, created_at").order("created_at", { ascending: false });
  if (error) return false;
  index = (data || []).map((r) => ({ id: r.id, task_id: r.task_id, body: r.body || "" }));
  return true;
}

export function searchComments(query) {
  const l = String(query || "").trim().toLowerCase();
  if (!index || !l) return [];
  return index.filter((r) => r.body.toLowerCase().includes(l) && getTask(r.task_id))
    .map((r) => ({ ...r, task: getTask(r.task_id) }));
}

function indexPut(c) {
  if (!index) return;
  const i = index.findIndex((r) => r.id === c.id);
  const row = { id: c.id, task_id: c.task_id, body: c.body || "" };
  if (i >= 0) index[i] = row; else index.unshift(row);
}
function indexDrop(id) { if (index) index = index.filter((r) => r.id !== id); }

// ---------- Ondertekende links ----------
const urls = new Map(); // path -> { url, exp }

async function signUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => p && !(urls.get(p)?.exp > now + 60e3));
  if (!need.length) return;
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, URL_TTL);
  (data || []).forEach((x) => { if (x.signedUrl) urls.set(x.path, { url: x.signedUrl, exp: now + (URL_TTL - 120) * 1000 }); });
}

function freshUrl(path) {
  const u = urls.get(path);
  return u && u.exp > Date.now() + 30e3 ? u.url : null;
}

// ---------- Draden per taak ----------
const threads = new Map(); // taskId -> { comments: [], loaded, loading }
const mounted = new Set(); // open detailweergaven

function thread(taskId) {
  let t = threads.get(taskId);
  if (!t) { t = { comments: [], loaded: false, loading: null, error: false }; threads.set(taskId, t); }
  return t;
}

function changed(taskId) { mounted.forEach((m) => { if (m.taskId === taskId) m.render(); }); }

const att = (r) => ({ ...r, url: null });

function loadThread(taskId) {
  const th = thread(taskId);
  if (th.loading) return th.loading;
  th.loading = (async () => {
    const [c, a] = await Promise.all([
      sb.from("task_comments").select("*").eq("task_id", taskId).order("created_at", { ascending: true }),
      sb.from("task_attachments").select("*").eq("task_id", taskId).order("created_at", { ascending: true }),
    ]);
    th.loading = null;
    if (c.error) { th.error = !th.loaded; changed(taskId); return; }
    const atts = a.error ? [] : (a.data || []);
    try { await signUrls(atts.map((x) => x.path)); } catch (e) { console.warn("Links ophalen mislukt:", e); }
    const byComment = new Map();
    const loose = [];
    for (const r of atts) {
      const x = att(r);
      x.url = freshUrl(r.path);
      if (r.comment_id) { if (!byComment.has(r.comment_id)) byComment.set(r.comment_id, []); byComment.get(r.comment_id).push(x); }
      else loose.push(x);
    }
    const list = (c.data || []).map((r) => ({ ...r, attachments: byComment.get(r.id) || [], _saved: true }));
    // Bijlagen zonder opmerking (niet vanuit de app, maar de database staat het toe).
    if (loose.length) list.push({ id: "loose-" + taskId, task_id: taskId, body: "", created_at: loose[0].created_at, updated_at: loose[0].created_at, attachments: loose, _loose: true, _saved: true });
    // Nog niet verstuurde opmerkingen van deze sessie bewaren.
    const local = th.comments.filter((x) => !x._saved || x._state);
    th.comments = [...list.filter((x) => !local.some((l) => l.id === x.id)), ...local]
      .sort((p, q) => String(p.created_at).localeCompare(String(q.created_at)));
    th.loaded = true;
    th.error = false;
    // Tellers bijwerken met wat er echt staat.
    const prev = counts.get(taskId) || { c: 0, a: 0 };
    const next = { c: (c.data || []).length, a: atts.length };
    if (prev.c !== next.c || prev.a !== next.a) { counts.set(taskId, next); emit(); }
    changed(taskId);
  })();
  return th.loading;
}

// ---------- Opmaak ----------
function pad(n) { return String(n).padStart(2, "0"); }

// "vandaag 09:12", "gisteren 21:30", "3 nov", "3 nov 2025"
export function commentTime(iso, now = new Date()) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days <= 0) return `vandaag ${clock}`;
  if (days === 1) return `gisteren ${clock}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : ""}`;
}

function fullTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("nl-NL", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fileSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toLocaleString("nl-NL", { maximumFractionDigits: 1 })} MB`;
}

// Tekst escapen en links klikbaar maken. Eerst splitsen, dan elk stuk apart
// escapen, zodat er nooit ruwe HTML in komt.
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
export function linkify(text) {
  const s = String(text || "");
  let out = "", last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[1];
    // Leestekens aan het eind horen meestal bij de zin, niet bij de link.
    const trail = url.match(/[.,!?;:)\]]+$/);
    if (trail && !(trail[0].startsWith(")") && url.includes("("))) url = url.slice(0, -trail[0].length);
    const start = m.index;
    out += escapeHtml(s.slice(last, start));
    const href = /^www\./i.test(url) ? "https://" + url : url;
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(s.slice(last));
}

const isImage = (mime) => /^image\/(jpeg|png|gif|webp|avif|bmp)$/i.test(mime || "");

function spinner() { return `<svg class="icon-sm spin" aria-hidden="true"><use href="#i-rings"/></svg>`; }

function attachmentsHtml(c) {
  const imgs = c.attachments.filter((a) => isImage(a.mime_type) && a.url);
  const files = c.attachments.filter((a) => !imgs.includes(a));
  let html = "";
  if (imgs.length) {
    html += `<div class="cmt-media ${imgs.length === 1 ? "one" : ""}">${imgs.map((a) => {
      const ratio = imgs.length === 1 && a.width && a.height ? `style="aspect-ratio:${a.width}/${a.height}"` : "";
      const busy = a._state === "uploading";
      return `<button type="button" class="cmt-thumb ${busy ? "is-busy" : ""} ${a._state === "failed" ? "is-failed" : ""}" data-cact="view" data-aid="${escapeHtml(a.id)}" ${ratio} aria-label="Afbeelding bekijken: ${escapeHtml(a.name)}">
        <img src="${escapeHtml(a.url)}" alt="" loading="lazy" decoding="async">${busy ? `<span class="cmt-busy">${spinner()}</span>` : ""}</button>`;
    }).join("")}</div>`;
  }
  if (files.length) {
    html += `<div class="cmt-files">${files.map((a) => {
      const busy = a._state === "uploading";
      return `<button type="button" class="cmt-file ${a._state === "failed" ? "is-failed" : ""}" data-cact="file" data-aid="${escapeHtml(a.id)}" aria-label="Bestand openen: ${escapeHtml(a.name)}">
        <span class="cmt-file-ic">${busy ? spinner() : icon("file", "icon-sm")}</span>
        <span class="cmt-file-name">${escapeHtml(a.name)}</span>
        <span class="cmt-file-size">${escapeHtml(fileSize(a.size_bytes))}</span>
      </button>`;
    }).join("")}</div>`;
  }
  return html;
}

function commentHtml(c) {
  const edited = c._saved && c.updated_at && new Date(c.updated_at) - new Date(c.created_at) > 1000;
  let status;
  if (c._state === "sending") status = `<span class="cmt-status">Versturen…</span>`;
  else if (c._state === "failed") status = `<button type="button" class="cmt-retry" data-cact="retry">${icon("alert", "icon-xs")}Niet verstuurd · <u>Opnieuw proberen</u></button>`;
  else status = `<time datetime="${escapeHtml(c.created_at)}" title="${escapeHtml(fullTime(c.created_at))}">${escapeHtml(commentTime(c.created_at))}</time>${edited ? `<span class="cmt-edited">· bewerkt</span>` : ""}`;
  return `
    <article class="cmt ${c._state ? "is-" + c._state : ""}" data-cid="${escapeHtml(c.id)}">
      <div class="cmt-head">
        ${status}
        <span class="grow"></span>
        ${c._loose || c._state === "sending" ? "" : `<button type="button" class="icon-btn sm cmt-more" data-cact="more" aria-label="Opties voor opmerking">${icon("more", "icon-sm")}</button>`}
      </div>
      ${c.body ? `<div class="cmt-body">${linkify(c.body)}</div>` : ""}
      ${c.attachments.length ? attachmentsHtml(c) : ""}
    </article>`;
}

// ---------- Afbeeldingen verkleinen ----------
function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("afbeelding laden mislukt"));
    i.src = src;
  });
}

// Max. 2000 px langste zijde, JPEG 0,85. GIF (animatie) en SVG blijven zoals
// ze zijn; lukt decoderen niet (bijv. HEIC buiten Safari), dan het origineel.
async function prepare(file) {
  const mime = file.type || "application/octet-stream";
  const base = { blob: file, name: file.name || "bestand", mime, size: file.size, width: null, height: null };
  if (!/^image\//i.test(mime) || /gif|svg/i.test(mime)) return base;
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImg(src);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return base;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const tw = Math.round(w * scale), th = Math.round(h * scale);
    const canvas = document.createElement("canvas");
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparante PNG's niet zwart laten worden
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(img, 0, 0, tw, th);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (!blob) return { ...base, width: w, height: h };
    // Al klein genoeg en kleiner dan de JPEG? Dan het origineel houden.
    if (scale === 1 && /jpeg|png|webp/i.test(mime) && blob.size >= file.size) return { ...base, width: w, height: h };
    const name = (file.name || "foto").replace(/\.[^.]+$/, "") + ".jpg";
    return { blob, name, mime: "image/jpeg", size: blob.size, width: tw, height: th };
  } catch {
    return base;
  } finally {
    URL.revokeObjectURL(src);
  }
}

function safeName(name) {
  const s = String(name || "bestand").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|-+$/g, "");
  return (s || "bestand").slice(-80);
}

async function currentUserId() {
  if (state.user?.id) return state.user.id;
  const { data } = await sb.auth.getSession();
  return data?.session?.user?.id || null;
}

// ---------- Versturen ----------
async function deliver(c) {
  const taskId = c.task_id;
  c._state = "sending";
  c.attachments.forEach((a) => { if (!a._done) a._state = "uploading"; });
  changed(taskId);
  try {
    const uid = await currentUserId();
    if (!uid) throw new Error("niet ingelogd");
    let tooBig = false;
    const results = await Promise.allSettled(c.attachments.map(async (a) => {
      if (a._done) return;
      const f = await a._ready;
      if (f.size > MAX_BYTES) { tooBig = true; a._state = "failed"; throw new Error("te groot"); }
      a.path = a.path || `${uid}/${taskId}/${uuid()}-${safeName(a.name)}`;
      const { error } = await sb.storage.from(BUCKET).upload(a.path, f.blob, { contentType: a.mime_type, upsert: false });
      // Een eerdere poging kan wel aangekomen zijn zonder dat we het hoorden.
      if (error && !/exist|duplicate/i.test(error.message || "")) { a._state = "failed"; throw error; }
      a._done = true;
      a._state = null;
      changed(taskId);
    }));
    const bad = results.find((r) => r.status === "rejected");
    if (bad) {
      if (tooBig) toast("Bestand is te groot (max. 25 MB).");
      throw bad.reason;
    }
    if (!c._saved) {
      const { error } = await sb.from("task_comments").insert({ id: c.id, task_id: taskId, body: c.body });
      if (error) throw error;
      c._saved = true;
      bump(taskId, "c", 1);
      indexPut(c);
    }
    if (c.attachments.length && !c._attsSaved) {
      const rows = c.attachments.map((a) => ({
        id: a.id, task_id: taskId, comment_id: c.id, path: a.path, name: a.name,
        mime_type: a.mime_type, size_bytes: a.size_bytes, width: a.width, height: a.height,
      }));
      const { error } = await sb.from("task_attachments").insert(rows);
      if (error) throw error;
      c._attsSaved = true;
      bump(taskId, "a", rows.length);
    }
    c._state = null;
    emit();
    // Alvast links ophalen, zodat tikken op een bestand meteen opent.
    signUrls(c.attachments.map((a) => a.path)).catch(() => {});
  } catch (e) {
    console.warn("Opmerking versturen mislukt:", e);
    c._state = "failed";
  }
  changed(taskId);
}

async function removeComment(c) {
  const th = thread(c.task_id);
  const paths = c.attachments.map((a) => a.path).filter(Boolean);
  const i = th.comments.indexOf(c);
  th.comments = th.comments.filter((x) => x !== c);
  changed(c.task_id);
  if (!c._saved) {
    // Nooit opgeslagen: alleen eventueel al geüploade bestanden opruimen.
    const up = c.attachments.filter((a) => a._done).map((a) => a.path);
    if (up.length) sb.storage.from(BUCKET).remove(up).catch(() => {});
    return;
  }
  const { error } = await sb.from("task_comments").delete().eq("id", c.id);
  if (error) {
    th.comments.splice(Math.max(0, i), 0, c);
    changed(c.task_id);
    toast("Verwijderen mislukt. Probeer het opnieuw.");
    return;
  }
  bump(c.task_id, "c", -1);
  if ((c._attsSaved || !c._state) && c.attachments.length) bump(c.task_id, "a", -c.attachments.length);
  indexDrop(c.id);
  emit();
  if (paths.length) {
    const { error: e2 } = await sb.storage.from(BUCKET).remove(paths).catch((err) => ({ error: err }));
    if (e2) console.warn("Bestanden opruimen mislukt:", e2);
  }
  toast("Opmerking verwijderd");
}

async function saveEdit(c, body) {
  const prev = { body: c.body, updated_at: c.updated_at };
  c.body = body;
  c.updated_at = new Date().toISOString();
  changed(c.task_id);
  // updated_at zet de database zelf (trigger).
  const { error } = await sb.from("task_comments").update({ body }).eq("id", c.id);
  if (error) {
    Object.assign(c, prev);
    changed(c.task_id);
    toast("Opslaan mislukt. Probeer het opnieuw.");
    return false;
  }
  indexPut(c);
  return true;
}

// ---------- Bestand openen / afbeelding bekijken ----------
async function openFile(a) {
  if (!a.path) { if (a.url) window.open(a.url, "_blank", "noopener"); return; }
  const now = freshUrl(a.path);
  if (now) { window.open(now, "_blank", "noopener"); return; }
  // Eerst het venster openen (nog binnen de tik), dan de link erin zetten;
  // anders blokkeert iOS het als pop-up.
  const w = window.open("", "_blank");
  await signUrls([a.path]);
  const u = freshUrl(a.path);
  if (u && w) { try { w.opener = null; } catch {} w.location.href = u; }
  else { if (w) w.close(); toast("Openen mislukt. Probeer het opnieuw."); }
}

function openViewer(a) {
  const sh = openSheet({
    className: "viewer",
    label: a.name || "Afbeelding",
    html: `
      <div class="viewer-bar">
        <button type="button" class="icon-btn" data-v="open" aria-label="Origineel openen">${icon("download")}</button>
        <button type="button" class="icon-btn" data-v="close" aria-label="Sluiten">${icon("x")}</button>
      </div>
      <img class="viewer-img" src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name || "")}">`,
  });
  sh.el.addEventListener("click", (e) => {
    if (e.target.closest('[data-v="open"]')) { openFile(a); return; }
    sh.close();
  });
  sh.q('[data-v="close"]').focus({ preventScroll: true });
  return sh;
}

// ---------- In de taakdetails ----------
const drafts = new Map(); // taskId -> { text, files }

export function mountComments(sh, taskId) {
  const th = thread(taskId);
  const scroll = sh.q(".detail-scroll");
  sh.el.classList.add("has-composer");

  const section = document.createElement("section");
  section.className = "cmts";
  section.setAttribute("aria-label", "Opmerkingen");
  section.innerHTML = `
    <p class="sheet-label">Opmerkingen <span class="cmt-count"></span></p>
    <div class="cmt-list" aria-live="polite"></div>`;
  scroll.appendChild(section);

  const composer = document.createElement("form");
  composer.className = "cmt-composer no-swipe";
  composer.innerHTML = `
    <div class="cmt-editing" hidden>${icon("edit", "icon-xs")}<span class="grow">Opmerking bewerken</span>
      <button type="button" class="icon-btn sm" data-k="cancel-edit" aria-label="Bewerken annuleren">${icon("x", "icon-sm")}</button></div>
    <div class="cmt-pending" hidden></div>
    <div class="cmt-bar">
      <button type="button" class="icon-btn cmt-attach" data-k="attach" aria-label="Bijlage toevoegen">${icon("clip")}</button>
      <textarea class="cmt-input" rows="1" placeholder="Opmerking toevoegen" aria-label="Opmerking toevoegen"></textarea>
      <button type="submit" class="cmt-send" aria-label="Versturen" disabled>${icon("send", "icon-sm")}</button>
    </div>
    <input type="file" class="cmt-file-input" multiple accept="image/*,application/pdf,*/*" hidden>`;
  sh.el.appendChild(composer);

  const listEl = section.querySelector(".cmt-list");
  const countEl = section.querySelector(".cmt-count");
  const input = composer.querySelector(".cmt-input");
  const sendBtn = composer.querySelector(".cmt-send");
  const fileInput = composer.querySelector(".cmt-file-input");
  const pendingEl = composer.querySelector(".cmt-pending");
  const editBar = composer.querySelector(".cmt-editing");

  let pending = [];   // gekozen bestanden, nog niet verstuurd
  let editing = null; // opmerking die je bewerkt
  const els = new Map(); // id -> { html, el }

  const draft = drafts.get(taskId);
  if (draft) { input.value = draft.text; pending = draft.files; drafts.delete(taskId); }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 132) + "px";
  }

  function updateSend() {
    const hasText = !!input.value.trim();
    sendBtn.disabled = editing ? (!hasText && !editing.attachments.length) : (!hasText && !pending.length);
  }

  function render() {
    const list = th.comments;
    const n = list.filter((c) => !c._loose).length;
    countEl.textContent = n ? String(n) : "";
    if (!th.loaded) {
      listEl.innerHTML = th.error
        ? `<p class="cmt-empty">Opmerkingen laden mislukt. <button type="button" class="link-inline" data-cact="reload">Opnieuw</button></p>`
        : `<div class="cmt-skel" aria-hidden="true"><span class="sk" style="width:30%"></span><span class="sk" style="width:85%"></span><span class="sk" style="width:55%"></span></div>`;
      els.clear();
      return;
    }
    if (!list.length) {
      listEl.innerHTML = `<p class="cmt-empty">Nog geen opmerkingen.</p>`;
      els.clear();
      return;
    }
    if (listEl.querySelector(".cmt-skel, .cmt-empty")) listEl.innerHTML = "";
    // Alleen gewijzigde opmerkingen opnieuw opbouwen, zodat afbeeldingen niet knipperen.
    const seen = new Set();
    let prevEl = null;
    for (const c of list) {
      seen.add(c.id);
      const html = commentHtml(c);
      let rec = els.get(c.id);
      if (!rec || rec.html !== html) {
        const tmp = document.createElement("div");
        tmp.innerHTML = html.trim();
        const el = tmp.firstElementChild;
        if (rec) rec.el.replaceWith(el);
        rec = { html, el };
        els.set(c.id, rec);
      }
      const want = prevEl ? prevEl.nextElementSibling : listEl.firstElementChild;
      if (want !== rec.el) listEl.insertBefore(rec.el, want);
      prevEl = rec.el;
    }
    for (const [id, rec] of els) if (!seen.has(id)) { rec.el.remove(); els.delete(id); }
  }

  function renderPending() {
    pendingEl.hidden = !pending.length;
    pendingEl.innerHTML = pending.map((p) => {
      const img = p.prepared && isImage(p.prepared.mime);
      const x = `<button type="button" class="cmt-chip-x" data-k="unpick" data-pid="${p.id}" aria-label="${escapeHtml(p.file.name)} weghalen">${icon("x", "icon-xs")}</button>`;
      if (!p.prepared) return `<span class="cmt-chip is-busy">${spinner()}<span class="cmt-chip-name">${escapeHtml(p.file.name)}</span>${x}</span>`;
      if (img) return `<span class="cmt-chip img"><img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.prepared.name)}">${x}</span>`;
      return `<span class="cmt-chip">${icon("file", "icon-sm")}<span class="cmt-chip-name">${escapeHtml(p.prepared.name)}</span><span class="cmt-chip-size">${escapeHtml(fileSize(p.prepared.size))}</span>${x}</span>`;
    }).join("");
    updateSend();
  }

  function pick(files) {
    for (const file of files) {
      if (!/^image\//i.test(file.type || "") && file.size > MAX_BYTES) {
        toast(`“${file.name}” is te groot (max. 25 MB).`);
        continue;
      }
      const p = { id: uuid(), file, prepared: null, url: null };
      p.ready = prepare(file).then((r) => {
        p.prepared = r;
        p.url = URL.createObjectURL(r.blob);
        if (r.size > MAX_BYTES) {
          toast(`“${r.name}” is te groot (max. 25 MB).`);
          unpick(p.id);
        } else renderPending();
        return r;
      });
      pending.push(p);
    }
    renderPending();
  }

  function unpick(pid) {
    const p = pending.find((x) => x.id === pid);
    if (!p) return;
    if (p.url) URL.revokeObjectURL(p.url);
    pending = pending.filter((x) => x !== p);
    renderPending();
  }

  function startEdit(c) {
    editing = c;
    editBar.hidden = false;
    composer.querySelector(".cmt-attach").hidden = true;
    pendingEl.hidden = true;
    input.value = c.body || "";
    autosize();
    updateSend();
    input.focus();
  }

  function stopEdit() {
    editing = null;
    editBar.hidden = true;
    composer.querySelector(".cmt-attach").hidden = false;
    input.value = "";
    autosize();
    renderPending();
  }

  function scrollToEnd() {
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  async function submit() {
    const body = input.value.replace(/^\s*\n|\s+$/g, "");
    if (editing) {
      if (!body.trim() && !editing.attachments.length) return;
      const c = editing;
      stopEdit();
      if (body !== c.body) await saveEdit(c, body);
      return;
    }
    if (!body.trim() && !pending.length) return;
    const files = pending;
    pending = [];
    input.value = "";
    autosize();
    renderPending();
    const now = new Date().toISOString();
    const c = {
      id: uuid(), task_id: taskId, body: body.trim() ? body : "", created_at: now, updated_at: now,
      _saved: false, _state: "sending",
      attachments: files.map((p) => ({
        id: uuid(), path: null, name: p.prepared ? p.prepared.name : p.file.name,
        mime_type: p.prepared ? p.prepared.mime : (p.file.type || "application/octet-stream"),
        size_bytes: p.prepared ? p.prepared.size : p.file.size,
        width: p.prepared?.width ?? null, height: p.prepared?.height ?? null,
        url: p.url, _ready: p.ready, _state: "uploading",
      })),
    };
    // Nog niet klaar met verkleinen? Dan de gegevens bijwerken zodra het kan.
    c.attachments.forEach((a, i) => {
      if (files[i].prepared) return;
      a._ready.then((r) => { Object.assign(a, { name: r.name, mime_type: r.mime, size_bytes: r.size, width: r.width, height: r.height, url: files[i].url }); changed(taskId); });
    });
    th.comments.push(c);
    changed(taskId);
    scrollToEnd();
    deliver(c);
  }

  composer.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  input.addEventListener("input", () => { autosize(); updateSend(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && editing) { e.preventDefault(); e.stopPropagation(); stopEdit(); }
  });
  fileInput.addEventListener("change", () => {
    pick([...fileInput.files]);
    fileInput.value = "";
  });
  composer.addEventListener("click", (e) => {
    const k = e.target.closest("[data-k]");
    if (!k) return;
    if (k.dataset.k === "attach") fileInput.click();
    if (k.dataset.k === "unpick") unpick(k.dataset.pid);
    if (k.dataset.k === "cancel-edit") stopEdit();
  });

  section.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cact]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.cact === "reload") { th.error = false; render(); loadThread(taskId); return; }
    const art = b.closest(".cmt");
    const c = art && th.comments.find((x) => x.id === art.dataset.cid);
    if (!c) return;
    const a = b.dataset.aid ? c.attachments.find((x) => x.id === b.dataset.aid) : null;
    switch (b.dataset.cact) {
      case "view": if (a) openViewer(a); break;
      case "file": if (a) openFile(a); break;
      case "retry": deliver(c); break;
      case "more": {
        const items = c._saved
          ? [{ id: "edit", label: "Bewerken", icon: "edit" }]
          : [{ id: "retry", label: "Opnieuw proberen", icon: "refresh" }];
        const r = await menuSheet({ groups: [{ items }, { items: [{ id: "del", label: "Verwijderen", icon: "trash", danger: true }] }] });
        if (r === "edit") startEdit(c);
        if (r === "retry") deliver(c);
        if (r === "del") {
          const ok = c._saved ? await confirmSheet({
            title: "Opmerking verwijderen?",
            text: c.attachments.length ? "De opmerking en de bijlagen worden definitief verwijderd." : "De opmerking wordt definitief verwijderd.",
          }) : true;
          if (ok) { if (editing === c) stopEdit(); removeComment(c); }
        }
        break;
      }
    }
  });

  const view = { taskId, render };
  mounted.add(view);
  render();
  renderPending();
  autosize();
  // Altijd opnieuw laden bij openen (goedkoop); tot dan wat er al was.
  loadThread(taskId);

  return {
    destroy() {
      mounted.delete(view);
      // Half geschreven opmerking bewaren voor de volgende keer.
      if (!editing && (input.value.trim() || pending.length)) drafts.set(taskId, { text: input.value, files: pending });
      else pending.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    },
  };
}
