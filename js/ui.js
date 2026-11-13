// Gedeelde UI-hulpjes: escapen, toast, sheets, bevestigen, haptiek.
// Bewust zonder afhankelijkheden van de rest van de app, zodat elke
// module dit kan importeren zonder kringverwijzingen.

export const $ = (id) => document.getElementById(id);

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  return safe.replace(new RegExp(escapeRegex(escapeHtml(query)), "gi"), (m) => `<mark>${m}</mark>`);
}

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check"/></svg>';

export function haptic() { try { if (navigator.vibrate) navigator.vibrate(8); } catch {} }

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvField(value) { return '"' + String(value ?? "").replace(/"/g, '""') + '"'; }

// Acties die modules elkaar laten aanroepen zonder elkaar te importeren
// (taak openen, snel toevoegen, navigeren). app.js vult ze in.
export const actions = {
  openTask: () => {},
  quickAdd: () => {},
  navigate: () => {},
  openNote: () => {},
  rerender: () => {},
  record: () => {},
};

// ---------- Toast ----------
// Alleen bij snel toevoegen (toetsenbord open) staat de toast bovenaan.
function topToast() {
  const top = sheetStack[sheetStack.length - 1];
  return !!top && top.el.classList.contains("quickadd");
}

let toastTimer;
export function toast(message, { action, duration } = {}) {
  const el = $("toast");
  if (!el) return;
  el.innerHTML = `<span>${escapeHtml(message)}</span>` +
    (action ? `<button type="button" class="toast-action">${escapeHtml(action.label)}</button>` : "");
  el.classList.toggle("has-action", !!action);
  // Met een sheet open staat de toast bovenaan, anders valt hij achter
  // het toetsenbord of over de knoppen van de sheet.
  el.classList.toggle("top", topToast());
  if (action) {
    el.querySelector(".toast-action").onclick = () => {
      el.classList.remove("show");
      clearTimeout(toastTimer);
      action.fn();
    };
  }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration || (action ? 4500 : 2600));
}

// ---------- Toetsenbordhoogte ----------
// iOS schuift het toetsenbord óver vaste elementen heen. Via visualViewport
// weten we hoe hoog het is; sheets gebruiken --kb om erboven te blijven.
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", (kb > 60 ? kb : 0) + "px");
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

// ---------- Sheets ----------
// Sheets worden gestapeld (bijv. datumkiezer boven op een taak). Voor de
// terugknop van de telefoon zetten we één history-entry neer zolang er
// sheets open zijn: "terug" sluit dan de bovenste sheet i.p.v. de app te
// verlaten.
export const sheetStack = [];
let sheetEntry = false;
let ignorePop = 0;

function scrim() { return $("scrim"); }

function layoutStack() {
  const s = scrim();
  sheetStack.forEach((sh, i) => { sh.el.style.zIndex = String(52 + i * 2); });
  if (sheetStack.length) {
    s.style.zIndex = String(51 + (sheetStack.length - 1) * 2);
    s.classList.add("open");
  } else {
    s.classList.remove("open");
  }
  document.body.classList.toggle("sheet-open", sheetStack.length > 0);
  // Toast mee laten verhuizen: boven als er een sheet open is, anders onder.
  const t = $("toast");
  if (t) t.classList.toggle("top", topToast());
}

export function openSheet({ html = "", className = "", label = "", role = "dialog", url = null, onClose, replace = false } = {}) {
  if (replace && sheetStack.length) closeTopSheet({ silent: true });
  const el = document.createElement("div");
  el.className = "sheet " + className;
  el.setAttribute("role", role);
  el.setAttribute("aria-modal", "true");
  if (label) el.setAttribute("aria-label", label);
  el.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div>${html}`;
  $("sheets").appendChild(el);
  // Een oude toast zou midden over de nieuwe sheet zweven: wegdoen.
  const t = $("toast");
  if (t) { t.classList.remove("show"); clearTimeout(toastTimer); }
  const sheet = {
    el, url, onClose, closed: false,
    close: () => closeSheet(sheet),
    q: (sel) => el.querySelector(sel),
    qa: (sel) => el.querySelectorAll(sel),
  };
  sheetStack.push(sheet);
  layoutStack();
  void el.offsetHeight;
  el.classList.add("open");
  enableSwipeClose(sheet);

  if (!sheetEntry) {
    history.pushState({ nota: "sheet" }, "", url || location.href);
    sheetEntry = true;
  } else if (url) {
    history.replaceState({ nota: "sheet" }, "", url);
  }
  return sheet;
}

function removeSheetEl(sheet) {
  const el = sheet.el;
  el.classList.remove("open");
  el.style.transform = "";
  const done = () => el.remove();
  if (reducedMotion()) done(); else setTimeout(done, 320);
}

export function closeSheet(sheet, { fromPop = false } = {}) {
  if (!sheet || sheet.closed) return;
  sheet.closed = true;
  const i = sheetStack.indexOf(sheet);
  if (i >= 0) sheetStack.splice(i, 1);
  removeSheetEl(sheet);
  layoutStack();
  try { sheet.onClose && sheet.onClose(); } catch (e) { console.warn(e); }
  if (document.activeElement && sheet.el.contains(document.activeElement)) document.activeElement.blur();
  if (fromPop) return;
  // Laatste sheet dicht via de UI: de history-entry weer opruimen. Even
  // wachten, zodat "sluit en open meteen de volgende" de entry hergebruikt.
  setTimeout(() => {
    if (sheetStack.length === 0 && sheetEntry) {
      sheetEntry = false;
      ignorePop++;
      history.back();
    }
  }, 0);
}

export function closeTopSheet(opts) {
  const top = sheetStack[sheetStack.length - 1];
  if (top) closeSheet(top, opts);
}

export function closeAllSheets() {
  while (sheetStack.length) closeSheet(sheetStack[sheetStack.length - 1], { fromPop: true });
  if (sheetEntry) { sheetEntry = false; ignorePop++; history.back(); }
}

// Wacht tot een geplande history.back() van een gesloten sheet klaar is,
// zodat een navigatie daarna niet door die "terug" ongedaan wordt.
let idleWaiters = [];
export function whenHistoryIdle() {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (ignorePop === 0) return resolve();
      idleWaiters.push(resolve);
      setTimeout(resolve, 600);
    }, 0);
  });
}

// Geeft true terug als de popstate door de sheets is afgehandeld.
export function handleSheetPop() {
  if (ignorePop > 0) {
    ignorePop--;
    if (ignorePop === 0) { idleWaiters.forEach((r) => r()); idleWaiters = []; }
    return true;
  }
  if (sheetEntry && sheetStack.length) {
    sheetEntry = false;
    closeSheet(sheetStack[sheetStack.length - 1], { fromPop: true });
    if (sheetStack.length) {
      const withUrl = [...sheetStack].reverse().find((s) => s.url);
      history.pushState({ nota: "sheet" }, "", withUrl ? withUrl.url : location.href);
      sheetEntry = true;
    }
    return true;
  }
  sheetEntry = false;
  return false;
}

export function initSheets() {
  scrim().addEventListener("click", () => closeTopSheet());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetStack.length) { e.preventDefault(); closeTopSheet(); }
  });
}

// Sheets omlaag vegen om te sluiten. Niet als je in een veld zit of
// als de inhoud van de sheet zelf nog naar boven kan scrollen.
function enableSwipeClose(sheet) {
  const el = sheet.el;
  let startY = null, dy = 0, active = false;
  el.addEventListener("touchstart", (e) => {
    const t = e.target;
    if (t.closest("input, textarea, select, .no-swipe")) { startY = null; return; }
    const scroller = t.closest(".sheet-scroll");
    if (scroller && scroller.scrollTop > 0) { startY = null; return; }
    startY = e.touches[0].clientY; dy = 0; active = false;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    dy = e.touches[0].clientY - startY;
    if (!active && dy > 8) { active = true; el.style.transition = "none"; }
    if (active) el.style.transform = `translateY(${Math.max(0, dy)}px)`;
    // De pagina achter de sheet niet laten meescrollen: niet tijdens het
    // omlaag vegen, en niet op delen van de sheet die zelf niet scrollen.
    if (e.cancelable && (active || !e.target.closest(".sheet-scroll, textarea, .chips"))) e.preventDefault();
  }, { passive: false });
  el.addEventListener("touchend", () => {
    if (startY === null) return;
    el.style.transition = "";
    if (active && dy > 90) sheet.close(); else el.style.transform = "";
    startY = null; active = false;
  });
}

// ---------- Standaard-sheets ----------
export function confirmSheet({ title, text = "", ok = "Verwijderen", danger = true }) {
  return new Promise((resolve) => {
    let answered = false;
    const sh = openSheet({
      role: "alertdialog",
      label: title,
      html: `
        <p class="sheet-title">${escapeHtml(title)}</p>
        ${text ? `<p class="sheet-sub">${escapeHtml(text)}</p>` : ""}
        <div class="sheet-actions">
          <button type="button" class="btn-cancel" data-a="cancel">Annuleren</button>
          <button type="button" class="${danger ? "btn-danger" : "btn-ok"}" data-a="ok">${escapeHtml(ok)}</button>
        </div>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    sh.el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      answered = true;
      resolve(b.dataset.a === "ok");
      sh.close();
    });
  });
}

export function promptSheet({ title, value = "", placeholder = "", ok = "Opslaan", type = "text", sub = "", autocomplete = "off" }) {
  return new Promise((resolve) => {
    let answered = false;
    const sh = openSheet({
      label: title,
      className: "kb-aware",
      html: `
        <p class="sheet-title">${escapeHtml(title)}</p>
        ${sub ? `<p class="sheet-sub">${escapeHtml(sub)}</p>` : ""}
        <form class="prompt-form">
          <input class="input" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="${autocomplete}" enterkeyhint="done" aria-label="${escapeHtml(title)}">
          <div class="sheet-actions">
            <button type="button" class="btn-cancel" data-a="cancel">Annuleren</button>
            <button type="submit" class="btn-ok">${escapeHtml(ok)}</button>
          </div>
        </form>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    const input = sh.q("input");
    input.focus({ preventScroll: true });
    if (value) input.select();
    sh.q("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      answered = true;
      resolve(v);
      sh.close();
    });
    sh.q('[data-a="cancel"]').addEventListener("click", () => sh.close());
  });
}

// Simpel keuzemenu als sheet. items: [{id, label, icon, danger, hint, checked}]
export function menuSheet({ title = "", sub = "", groups }) {
  return new Promise((resolve) => {
    let answered = false;
    const sh = openSheet({
      label: title || "Menu",
      html: `
        ${title ? `<p class="sheet-title">${escapeHtml(title)}</p>` : ""}
        ${sub ? `<p class="sheet-sub">${escapeHtml(sub)}</p>` : ""}
        <div class="sheet-scroll menu-scroll">
        ${groups.map((g) => `
          ${g.label ? `<p class="sheet-label">${escapeHtml(g.label)}</p>` : ""}
          ${g.segmented ? `
          <div class="segmented" style="--n:${g.items.length}" role="group" aria-label="${escapeHtml(g.label || "")}">
            ${g.items.map((it) => `
              <button type="button" class="sheet-item seg" data-id="${escapeHtml(it.id)}" aria-pressed="${!!it.checked}">${escapeHtml(it.label)}</button>`).join("")}
          </div>` : `
          <div class="sheet-group">
            ${g.items.map((it) => `
              <button type="button" class="sheet-item ${it.danger ? "danger" : ""}" data-id="${escapeHtml(it.id)}" ${it.checked != null ? `aria-pressed="${!!it.checked}"` : ""}>
                ${it.icon ? icon(it.icon) : it.dot ? `<span class="dot-lg" style="--c:${escapeHtml(it.dot)}"></span>` : ""}
                <span class="grow">${escapeHtml(it.label)}</span>
                ${it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : ""}
                ${it.checked ? icon("check", "icon-sm tick") : ""}
              </button>`).join("")}
          </div>`}`).join("")}
        </div>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    sh.el.addEventListener("click", (e) => {
      const b = e.target.closest(".sheet-item");
      if (!b) return;
      answered = true;
      resolve(b.dataset.id);
      sh.close();
    });
  });
}

// ---------- Kleine opmaakhulpjes ----------
export function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
