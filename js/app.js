// Nota: startpunt. Inloggen, navigatie (hash-routes), bovenbalk, tabbalk,
// plusknop, vernieuwen. De views zelf staan in js/views/.

import {
  $, escapeHtml, icon, toast, actions, haptic, initSheets, trackKeyboard, sheetStack,
  handleSheetPop, closeAllSheets, whenHistoryIdle,
} from "./ui.js";
import { sb, state, subscribe, loadAll, getTask, rescheduleTask } from "./store.js";
import { registerServiceWorker, resyncPush } from "./push.js";
import { bindTaskInteractions } from "./tasks.js";
import { openQuickAdd } from "./quickadd.js";
import { openTaskDetail } from "./detail.js";
import { dateSheet } from "./pickers.js";
import { openRecorder, loadRecordings, startPolling, watchPcStatus } from "./record.js";
import todayView from "./views/today.js";
import upcomingView from "./views/upcoming.js";
import projectView from "./views/project.js";
import notesView, { focusNote, stopPlayback } from "./views/notes.js";
import searchView from "./views/search.js";
import { labelView, filterView, completedView } from "./views/lists.js";
import { browseView, settingsView, changePassword } from "./views/browse.js";

const loginView = $("login-view");
const appView = $("app");
const viewEl = $("view");
const topbar = $("topbar");

// ---------- Thema ----------
function getThemePref() {
  try { return localStorage.getItem("nota-theme") || "auto"; } catch { return "auto"; }
}

function applyTheme(pref) {
  if (pref === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", pref);
  try { localStorage.setItem("nota-theme", pref); } catch {}
  document.querySelectorAll("[data-theme-value]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.themeValue === pref)));
  // Statusbalk-kleur meeschakelen
  const dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute("content", dark ? "#101215" : "#F5F6F7");
    m.removeAttribute("media");
  });
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getThemePref() === "auto") applyTheme("auto");
});
applyTheme(getThemePref());

// ---------- Routes ----------
const ROUTES = [
  [/^\/?$/, () => ({ view: todayView, params: {}, key: "vandaag" })],
  [/^\/vandaag$/, () => ({ view: todayView, params: {}, key: "vandaag" })],
  [/^\/inbox$/, () => ({ view: projectView, params: { id: null }, key: "inbox" })],
  [/^\/binnenkort$/, () => ({ view: upcomingView, params: {}, key: "binnenkort" })],
  [/^\/notities$/, () => ({ view: notesView, params: {}, key: "notities" })],
  [/^\/bladeren$/, () => ({ view: browseView, params: {}, key: "bladeren" })],
  [/^\/voltooid$/, () => ({ view: completedView, params: {}, key: "voltooid" })],
  [/^\/instellingen$/, () => ({ view: settingsView, params: {}, key: "instellingen" })],
  [/^\/zoeken$/, () => ({ view: searchView, params: {}, key: "zoeken" })],
  [/^\/project\/([^/]+)$/, (m) => ({ view: projectView, params: { id: m[1] }, key: "project/" + m[1] })],
  [/^\/label\/(.+)$/, (m) => ({ view: labelView, params: { name: decodeURIComponent(m[1]) }, key: "label/" + m[1] })],
  [/^\/filter\/([^/]+)$/, (m) => ({ view: filterView, params: { id: m[1] }, key: "filter/" + m[1] })],
  [/^\/taak\/([^/]+)$/, (m) => ({ task: m[1] })],
];

function parseHash(hash = location.hash) {
  const path = hash.replace(/^#/, "");
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) return fn(m);
  }
  return { view: todayView, params: {}, key: "vandaag" };
}

let current = null; // { view, params, key }
let navDepth = 0;

function baseUrl() { return location.href.split("#")[0]; }

export async function navigate(hash, { replace = false } = {}) {
  if (sheetStack.length) closeAllSheets();
  await whenHistoryIdle();
  const url = baseUrl() + hash;
  if (replace) history.replaceState({ nota: "view" }, "", url);
  else { history.pushState({ nota: "view" }, "", url); navDepth++; }
  route();
}

function goBack() {
  if (navDepth > 0) history.back();
  else navigate("#/bladeren", { replace: true });
}

function route() {
  const r = parseHash();
  if (r.task) {
    // Deeplink naar een taak: eronder Vandaag tonen.
    history.replaceState({ nota: "view" }, "", baseUrl() + "#/vandaag");
    show(parseHash("#/vandaag"));
    const id = r.task;
    const open = () => (getTask(id) ? openTaskDetail(id) : toast("Deze taak bestaat niet (meer)."));
    if (state.loaded) open(); else pendingTask = id;
    return;
  }
  show(r);
}
let pendingTask = null;

function show(r) {
  const same = current && current.key === r.key;
  if (current && !same && current.view.leave) current.view.leave();
  current = r;
  render({ first: !same });
  if (!same) window.scrollTo(0, 0);
}

window.addEventListener("popstate", () => {
  if (handleSheetPop()) return;
  if (navDepth > 0) navDepth--;
  route();
});

// Links naar "#/..." via navigate() laten lopen (één manier van navigeren).
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

// ---------- Renderen ----------
function tabOf(r) {
  const t = r.view.tab;
  return typeof t === "function" ? t(r.params) : t;
}

function renderTopbar(r) {
  const tb = r.view.topbar ? r.view.topbar(r.params) : { title: "" };
  const stripLeft = topbar.querySelector(".strip")?.scrollLeft || 0;
  const focusedId = topbar.contains(document.activeElement) ? document.activeElement.id : null;
  if (tb.search) {
    // Zoekbalk niet opnieuw opbouwen terwijl je typt.
    if (topbar.dataset.mode === "search" && $("global-search")) return;
    topbar.dataset.mode = "search";
    topbar.innerHTML = `<div class="wrap topbar-inner search-mode">
      <button type="button" class="icon-btn" data-act="back" aria-label="Terug">${icon("arrow-left")}</button>
      ${tb.html}
    </div>`;
    return;
  }
  topbar.dataset.mode = "";
  topbar.innerHTML = `
    <div class="wrap topbar-inner">
      <div class="tb-left">
        ${tb.back ? `<button type="button" class="icon-btn back" data-act="back" aria-label="Terug">${icon("arrow-left")}</button>` : ""}
        ${tb.logo ? `<img class="topbar-logo" src="logo.png" alt="Nota">` : ""}
      </div>
      <div class="tb-title ${tb.fixedTitle ? "fixed" : ""}" ${tb.fixedTitle ? 'role="heading" aria-level="1"' : 'aria-hidden="true"'}>${escapeHtml(tb.title || "")}</div>
      <div class="topbar-actions">
        ${(tb.actions || []).map((a) => `<button type="button" class="icon-btn" data-act="${a.act}" aria-label="${escapeHtml(a.label)}">${icon(a.icon)}</button>`).join("")}
      </div>
    </div>
    ${tb.extra || ""}`;
  const strip = topbar.querySelector(".strip");
  if (strip) {
    strip.scrollLeft = stripLeft;
    if (!stripLeft) strip.querySelector(".sel")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
  if (focusedId) $(focusedId)?.focus();
  updateTopbarScroll();
}

function renderTabs(r) {
  const tab = tabOf(r);
  document.querySelectorAll(".tabbar [data-tab]").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("fab").hidden = !!r.view.hideFab;
  const d = new Date().getDate();
  const n = document.querySelector(".tab-today-n");
  if (n && n.textContent !== String(d)) n.textContent = d;
}

function skeleton() {
  return `<section class="intro"><div class="sk" style="width:40%;height:30px;margin-bottom:12px"></div><div class="sk" style="width:25%"></div></section>
    <div class="card skeleton" aria-hidden="true">${[70, 50, 80, 40].map((w) => `<div class="sk-row"><span class="sk sk-c"></span><span class="sk" style="width:${w}%"></span></div>`).join("")}</div>`;
}

let loadError = null;
function render({ first = false, force = false } = {}) {
  if (!current) return;
  const r = current;
  renderTopbar(r);
  renderTabs(r);
  if (!state.loaded) {
    viewEl.innerHTML = loadError
      ? `<div class="card empty"><h3>Laden mislukt</h3><p>${escapeHtml(loadError)}</p><button type="button" class="btn-ghost" data-act="retry">Opnieuw proberen</button></div>`
      : skeleton();
    return;
  }
  // Na "rerender" altijd volledig opbouwen, anders mag de view zelf bijwerken.
  if (!first && !force && r.view.update && r.view.update(viewEl, r.params)) return;
  viewEl.innerHTML = r.view.render(r.params) + `<div class="footer-space"></div>`;
  if (r.view.after) r.view.after(viewEl, r.params, { first });
}

actions.rerender = () => render({ first: false, force: true });
subscribe(() => {
  if (!current) return;
  // Store-wijziging: alleen bijwerken, view mag zelf beslissen (notities).
  render({ first: false });
});

// ---------- Interactie ----------
function quickAddContext(extra = {}) {
  const base = current && current.view.context ? current.view.context(current.params) : {};
  return { ...base, ...extra };
}

actions.quickAdd = (ctx) => openQuickAdd(ctx && Object.keys(ctx).length ? ctx : quickAddContext());
actions.openTask = (id) => openTaskDetail(id);
actions.navigate = navigate;
actions.record = (ctx = {}) => openRecorder({ project_id: ctx.project_id !== undefined ? ctx.project_id : quickAddContext().project_id || null });
actions.openNote = async (id) => {
  await navigate("#/notities");
  setTimeout(() => focusNote(id), 60);
};
actions.logout = async () => {
  closeAllSheets();
  stopPlayback();
  watchPcStatus(false);
  await sb.auth.signOut();
  state.loaded = false;
  showLogin();
  $("password").value = "";
};

bindTaskInteractions(viewEl, {
  onSchedule: async (id) => {
    const t = getTask(id);
    if (!t) return;
    const r = await dateSheet({ due_date: t.due_date, due_time: t.due_time, recurrence: t.recurrence });
    if (r) rescheduleTask(id, { due_date: r.due_date, due_time: r.due_date ? r.due_time : null, recurrence: r.due_date ? r.recurrence : null });
  },
  // In notities en voltooid blijft een afgevinkte taak zichtbaar.
  keepVisible: (li) => !!li.closest(".note") || current?.key === "voltooid",
});

appView.addEventListener("click", async (e) => {
  if (!current) return;
  const v = current.view;
  if (v.onPlayClick && v.onPlayClick(e)) return;
  const tv = e.target.closest("[data-theme-value]");
  if (tv) { applyTheme(tv.dataset.themeValue); return; }
  const el = e.target.closest("[data-act]");
  if (!el || !appView.contains(el)) return;
  const act = el.dataset.act;
  if (act === "search") return navigate("#/zoeken");
  if (act === "back") return goBack();
  if (act === "retry") return refresh();
  if (act === "add") {
    const extra = {};
    if (el.hasAttribute("data-project")) { extra.project_id = el.dataset.project || null; extra.section_id = el.dataset.section || null; }
    if (el.dataset.date) extra.due_date = el.dataset.date;
    return openQuickAdd(quickAddContext(extra));
  }
  if (v.onClick) {
    const res = await v.onClick(act, el, current.params, e);
    if (res === "rerender") render({ first: false, force: true });
    if (res === "refresh") refresh();
  }
});
appView.addEventListener("pointerdown", (e) => current?.view.onPointerDown?.(e));
appView.addEventListener("keydown", (e) => current?.view.onKeyDown?.(e));
appView.addEventListener("input", (e) => current?.view.onInput?.(e));
appView.addEventListener("change", (e) => current?.view.onChange?.(e));

// Tabs: vervangen i.p.v. stapelen, zodat "terug" niet door tabs heen gaat.
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  e.preventDefault();
  const hash = b.getAttribute("href");
  if (current && tabOf(current) === b.dataset.tab && location.hash === hash) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  navDepth = 0;
  navigate(hash, { replace: true });
});

// Plusknop: tikken = snel toevoegen, lang indrukken = spraaknotitie.
(function fab() {
  const btn = $("fab");
  let timer = 0, long = false;
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(() => { long = true; haptic(); actions.record({}); }, 420);
  });
  const cancel = () => clearTimeout(timer);
  btn.addEventListener("pointerup", cancel);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("pointercancel", cancel);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    if (long) { e.preventDefault(); long = false; return; }
    actions.quickAdd();
  });
})();

// ---------- Scrollen ----------
function updateTopbarScroll() {
  topbar.classList.toggle("scrolled", scrollY > 4);
  topbar.classList.toggle("show-title", scrollY > 46);
}
addEventListener("scroll", () => {
  updateTopbarScroll();
  current?.view.onScroll?.();
}, { passive: true });

// Omlaag trekken om te vernieuwen (handig in de app zonder adresbalk)
(function pullToRefresh() {
  const ptr = $("ptr");
  const ic = ptr.querySelector("svg");
  let startY = null, pull = 0;
  document.addEventListener("touchstart", (e) => {
    if (scrollY > 0 || sheetStack.length || appView.style.display !== "block" || document.body.classList.contains("is-dragging")) return;
    if (e.target.closest(".strip, .tabbar, .fab")) return;
    startY = e.touches[0].clientY; pull = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    pull = Math.max(0, Math.min(90, (e.touches[0].clientY - startY) * 0.5));
    ptr.style.height = pull + "px";
    ic.style.transform = `rotate(${pull * 4}deg)`;
    ic.style.opacity = Math.min(1, pull / 60);
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (startY === null) return;
    startY = null;
    if (pull >= 60) {
      ptr.style.transition = "height 200ms";
      ptr.style.height = "50px";
      ic.classList.add("spin");
      haptic();
      await refresh();
      ic.classList.remove("spin");
    }
    ptr.style.transition = "height 200ms";
    ptr.style.height = "0px";
    setTimeout(() => { ptr.style.transition = ""; }, 220);
    pull = 0;
  });
})();

// ---------- Laden ----------
async function refresh() {
  const { error } = await loadAll();
  if (error) {
    if (!state.loaded) { loadError = error.message || String(error); render({ first: true }); }
    else toast("Vernieuwen mislukt. Probeer het opnieuw.");
    return;
  }
  loadError = null;
  loadRecordings();
}

// Vernieuwen als je terugkomt in de app (na een tijdje weg)
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (appView.style.display === "block") {
    if (Date.now() - hiddenAt > 60_000) refresh();
    startPolling();
  }
});

function showLogin() {
  appView.style.display = "none";
  loginView.style.display = "";
  document.body.classList.remove("in-app");
}

let booted = false;
async function showApp(session) {
  state.user = session?.user || state.user;
  loginView.style.display = "none";
  appView.style.display = "block";
  document.body.classList.add("in-app");
  if (!booted) {
    booted = true;
    route();
  }
  await refresh();
  resyncPush();
  if (pendingTask) { const id = pendingTask; pendingTask = null; if (getTask(id)) openTaskDetail(id); }
  // Snelkoppeling "Taak toevoegen" op het beginscherm: ?add=1
  const u = new URL(location.href);
  if (u.searchParams.get("add") === "1") {
    u.searchParams.delete("add");
    history.replaceState(history.state, "", u.toString());
    openQuickAdd(quickAddContext());
  }
}

// ---------- Inloggen ----------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error");
  const btn = $("login-btn");
  err.style.display = "none";
  btn.disabled = true;
  btn.innerHTML = '<svg class="icon spin"><use href="#i-rings"/></svg>Inloggen';
  const { data, error } = await sb.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  btn.disabled = false;
  btn.textContent = "Inloggen";
  if (error) {
    err.textContent = error.message === "Invalid login credentials"
      ? "E-mail of wachtwoord klopt niet."
      : "Inloggen mislukt: " + error.message;
    err.style.display = "block";
    return;
  }
  showApp(data?.session);
});

$("forgot-btn").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const err = $("login-error");
  if (!email) {
    err.textContent = "Vul eerst je e-mailadres in.";
    err.style.display = "block";
    $("email").focus();
    return;
  }
  err.style.display = "none";
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0].split("?")[0] });
  if (error) { err.textContent = "Versturen mislukt: " + error.message; err.style.display = "block"; return; }
  toast("Check je mail voor een link om je wachtwoord te herstellen.");
});

// Link uit de herstelmail: Supabase meldt PASSWORD_RECOVERY, dan direct
// een nieuw wachtwoord laten kiezen.
sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    showApp(session).then(() => changePassword({ recovery: true }));
  }
});

initSheets();
trackKeyboard();
window.__notaBooted = true;

// Service worker (meldingen + offline). Tik op een melding: de taak openen.
registerServiceWorker({
  onOpen: (url) => {
    const hash = url.slice(url.indexOf("#"));
    if (url.includes("#") && hash.startsWith("#/")) navigate(hash);
  },
});

// Automatisch inloggen als er al een geldige sessie is
sb.auth.getSession().then(({ data: { session } }) => {
  if (session) showApp(session);
  else showLogin();
});
