// Bladeren (projecten, labels, filters, voltooid) en Instellingen.

import { escapeHtml, icon, toast, promptSheet, downloadBlob, csvField, actions, menuSheet, confirmSheet } from "../ui.js";
import {
  state, sb, activeProjects, openTasks, createLabel, createFilter, byOrder, updateProject,
  projectById, sectionById, settings, saveSettings, SUPABASE_URL, pcState, agoText,
} from "../store.js";
import { watchPcStatus } from "../record.js";
import { editSheet } from "../pickers.js";
import { editProject } from "./project.js";
import { validateWithCount, filterTasks } from "./lists.js";
import { validateFilter } from "../parse.js";
import { exportNotes } from "./notes.js";
import { pushStatus, cachedPushStatus, enablePush, disablePush, sendTestPush } from "../push.js";

export const FILTER_PRESETS = [
  { name: "Prioriteit 1", query: "p1" },
  { name: "Achterstallig", query: "achterstallig" },
  { name: "Deze week", query: "7 dagen" },
  { name: "Zonder datum", query: "geen datum" },
];

function row({ href, act, id, lead, label, count = "", trail = "" }) {
  const attrs = href ? `href="${href}"` : `type="button" data-act="${act}" ${id ? `data-id="${escapeHtml(id)}"` : ""}`;
  const tag = href ? "a" : "button";
  return `<${tag} class="list-row" ${attrs}>${lead}<span class="grow">${label}</span>${trail}${count !== "" ? `<span class="count">${count}</span>` : ""}${icon("chevron-right", "icon-sm chev-r")}</${tag}>`;
}

export const browseView = {
  tab: "bladeren",
  topbar: () => ({
    title: "Bladeren",
    logo: true,
    actions: [{ act: "search", icon: "search", label: "Zoeken" }, { act: "menu", icon: "more", label: "Meer" }],
  }),
  render() {
    const open = openTasks();
    const inboxN = open.filter((t) => !t.project_id).length;
    const projects = activeProjects();
    const archived = state.projects.filter((p) => p.archived);
    const labels = [...state.labels].sort(byOrder);
    const usedLabels = new Set(open.flatMap((t) => t.labels));
    const looseLabels = [...usedLabels].filter((n) => !labels.some((l) => l.name.toLowerCase() === n.toLowerCase()));
    const filters = [...state.filters].sort(byOrder);
    const doneN = [...state.tasks.values()].filter((t) => t.completed).length;

    return `
      <section class="intro browse-intro"><h1>Bladeren</h1></section>
      <div class="card list-card">
        ${row({ href: "#/inbox", lead: `<span class="lead-ic" style="color:var(--accent)">${icon("inbox")}</span>`, label: "Inbox", count: inboxN || "" })}
        ${row({ href: "#/voltooid", lead: `<span class="lead-ic" style="color:var(--tone-today)">${icon("check-circle")}</span>`, label: "Voltooid", count: doneN || "" })}
      </div>

      <section class="group">
        <div class="group-head"><h2>Projecten</h2><span class="grow"></span>
          <button type="button" class="icon-btn sm" data-act="new-project" aria-label="Nieuw project">${icon("plus")}</button></div>
        <div class="card list-card">
          ${projects.length ? projects.map((p) => row({
            href: "#/project/" + p.id,
            lead: `<span class="lead-ic"><span class="dot-lg" style="--c:${escapeHtml(p.color)}"></span></span>`,
            label: escapeHtml(p.name),
            trail: p.favorite ? icon("star-fill", "icon-xs fav") : "",
            count: open.filter((t) => t.project_id === p.id).length || "",
          })).join("") : `<p class="list-empty">Nog geen projecten.</p>`}
          ${archived.length ? `<button type="button" class="list-row muted" data-act="archived"><span class="lead-ic">${icon("archive")}</span><span class="grow">Gearchiveerd</span><span class="count">${archived.length}</span>${icon("chevron-right", "icon-sm chev-r")}</button>` : ""}
        </div>
      </section>

      <section class="group">
        <div class="group-head"><h2>Labels</h2><span class="grow"></span>
          <button type="button" class="icon-btn sm" data-act="new-label" aria-label="Nieuw label">${icon("plus")}</button></div>
        <div class="card list-card">
          ${labels.length || looseLabels.length ? [...labels.map((l) => ({ name: l.name, color: l.color })), ...looseLabels.map((n) => ({ name: n, color: null }))].map((l) => row({
            href: "#/label/" + encodeURIComponent(l.name),
            lead: `<span class="lead-ic" style="color:${escapeHtml(l.color || "var(--muted)")}">${icon("tag")}</span>`,
            label: escapeHtml(l.name),
            count: open.filter((t) => t.labels.some((x) => x.toLowerCase() === l.name.toLowerCase())).length || "",
          })).join("") : `<p class="list-empty">Nog geen labels. Typ @label in een taak.</p>`}
        </div>
      </section>

      <section class="group">
        <div class="group-head"><h2>Filters</h2><span class="grow"></span>
          <button type="button" class="icon-btn sm" data-act="new-filter" aria-label="Nieuwe filter">${icon("plus")}</button></div>
        <div class="card list-card">
          ${filters.length ? filters.map((f) => row({
            href: "#/filter/" + f.id,
            lead: `<span class="lead-ic" style="color:${escapeHtml(f.color || "var(--muted)")}">${icon("filter")}</span>`,
            label: escapeHtml(f.name),
            count: validateFilter(f.query).ok ? (filterTasks(f.query).length || "") : "!",
          })).join("") : `<p class="list-empty">Nog geen filters.</p>`}
        </div>
        ${filters.length < 2 ? `<div class="chips presets">${FILTER_PRESETS.filter((p) => !filters.some((f) => f.query === p.query)).map((p) => `<button type="button" class="chip" data-act="preset" data-q="${escapeHtml(p.query)}" data-n="${escapeHtml(p.name)}">${icon("plus", "icon-xs")}${escapeHtml(p.name)}</button>`).join("")}</div>` : ""}
      </section>

      <div class="card list-card">
        ${row({ href: "#/instellingen", lead: `<span class="lead-ic">${icon("settings")}</span>`, label: "Instellingen" })}
      </div>`;
  },

  async onClick(act, el) {
    if (act === "new-project") {
      const p = await editProject(null);
      if (p) actions.navigate("#/project/" + p.id);
    }
    if (act === "new-label") {
      const r = await editSheet({ title: "Nieuw label", ok: "Toevoegen" });
      if (r) { await createLabel(r.name.replace(/^@/, ""), r.color); }
    }
    if (act === "new-filter") return newFilter();
    if (act === "preset") {
      const f = await createFilter({ name: el.dataset.n, query: el.dataset.q, color: "#808080" });
      if (f) toast(`Filter “${f.name}” toegevoegd`);
    }
    if (act === "archived") {
      const arch = state.projects.filter((p) => p.archived);
      const r = await menuSheet({ title: "Gearchiveerde projecten", sub: "Tik om terug te zetten.", groups: [{ items: arch.map((p) => ({ id: p.id, label: p.name, dot: p.color, icon: null })) }] });
      if (r) { await updateProject(r, { archived: false }); toast("Project teruggezet"); }
    }
    if (act === "menu") {
      const r = await menuSheet({ groups: [{ items: [
        { id: "refresh", label: "Vernieuwen", icon: "refresh" },
        { id: "settings", label: "Instellingen", icon: "settings" },
      ] }] });
      if (r === "refresh") return "refresh";
      if (r === "settings") actions.navigate("#/instellingen");
    }
  },
};

export async function newFilter() {
  const r = await editSheet({ title: "Nieuwe filter", query: "", validate: validateWithCount, ok: "Toevoegen", presets: FILTER_PRESETS });
  if (!r) return;
  const f = await createFilter({ name: r.name, query: r.query, color: r.color });
  if (f) actions.navigate("#/filter/" + f.id);
}

// ---------- Instellingen ----------
export const settingsView = {
  tab: "bladeren",
  topbar: () => ({ title: "Instellingen", back: true, actions: [] }),
  render() {
    const email = state.user?.email || "";
    let theme = "auto";
    try { theme = localStorage.getItem("nota-theme") || "auto"; } catch {}
    const pressed = (v) => `aria-pressed="${theme === v}"`;
    return `
      <section class="intro"><h1>Instellingen</h1>${email ? `<p>${escapeHtml(email)}</p>` : ""}</section>
      <p class="sheet-label">Weergave</p>
      <div class="segmented" data-theme-switch>
        <button type="button" data-theme-value="auto" ${pressed("auto")}>${icon("auto", "icon-sm")}Auto</button>
        <button type="button" data-theme-value="light" ${pressed("light")}>${icon("sun", "icon-sm")}Licht</button>
        <button type="button" data-theme-value="dark" ${pressed("dark")}>${icon("moon", "icon-sm")}Donker</button>
      </div>
      <p class="sheet-label">Meldingen</p>
      <div class="card list-card push-card" data-push>${pushGroup(cachedPushStatus())}</div>
      <div class="card list-card digest-card" data-digest>${digestGroup()}</div>
      <p class="sheet-label">Agenda</p>
      <div class="card list-card" data-agenda>${agendaGroup()}</div>
      <p class="sheet-label">Computer</p>
      <div class="card list-card" data-pc-row>${computerRow()}</div>
      <p class="sheet-label">Exporteren</p>
      <div class="card list-card">
        <button type="button" class="list-row" data-act="export-txt"><span class="lead-ic">${icon("download")}</span><span class="grow">Notities als tekst</span><span class="hint">.txt</span></button>
        <button type="button" class="list-row" data-act="export-csv"><span class="lead-ic">${icon("download")}</span><span class="grow">Notities als spreadsheet</span><span class="hint">.csv</span></button>
        <button type="button" class="list-row" data-act="export-tasks"><span class="lead-ic">${icon("download")}</span><span class="grow">Taken als spreadsheet</span><span class="hint">.csv</span></button>
      </div>
      <p class="sheet-label">Account</p>
      <div class="card list-card">
        <button type="button" class="list-row" data-act="password"><span class="lead-ic">${icon("key")}</span><span class="grow">Wachtwoord wijzigen</span></button>
        <button type="button" class="list-row danger" data-act="logout"><span class="lead-ic">${icon("logout")}</span><span class="grow">Uitloggen</span></button>
      </div>
      <p class="footnote">Nota · taken en spraaknotities</p>`;
  },
  after(el) { refreshPushGroup(el); watchPcStatus(true); },
  // Store-wijzigingen: alleen de blokken bijwerken, zodat een open
  // tijdkiezer niet verdwijnt.
  update(root) {
    if (!root.querySelector("[data-digest]")) return false;
    updateDigest(root);
    const ag = root.querySelector("[data-agenda]");
    if (ag) ag.innerHTML = agendaGroup();
    const pc = root.querySelector("[data-pc-row]");
    if (pc) pc.innerHTML = computerRow();
    return true;
  },
  leave() { watchPcStatus(false); },
  onChange(e) {
    const t = e.target;
    if (t.id === "digest-on") {
      const on = t.checked;
      saveSettings({ digest_enabled: on }).then((ok) => {
        if (ok) toast(on ? `Ochtendoverzicht staat aan, om ${settings().digest_time}` : "Ochtendoverzicht staat uit");
      });
    }
    if (t.id === "digest-time") {
      const v = (t.value || "").slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(v)) { t.value = settings().digest_time; return; }
      if (v === settings().digest_time) return;
      saveSettings({ digest_time: v }).then((ok) => { if (ok) toast(`Ochtendoverzicht om ${v}`); });
    }
  },
  async onClick(act, btn) {
    if (act === "push-on" || act === "push-test" || act === "push-off") return pushAction(act, btn);
    if (act === "digest-time-open") {
      // Het echte veld ligt onzichtbaar over de tijd heen; op een computer
      // opent een tik daarop niet vanzelf de kiezer.
      // Op een telefoon opent de tik op het veld zelf de kiezer al.
      if (matchMedia("(pointer: coarse)").matches) return;
      const input = btn.querySelector("input");
      try { input.showPicker(); } catch { input.focus(); }
      return;
    }
    if (act.startsWith("cal-")) return agendaAction(act);
    if (act === "export-txt") exportNotes("txt", state.notes);
    if (act === "export-csv") exportNotes("csv", state.notes);
    if (act === "export-tasks") exportTasks();
    if (act === "password") changePassword();
    if (act === "logout") actions.logout();
  },
};

// ---------- Meldingen ----------
const PUSH_TEXT = {
  on: "Aan op dit apparaat",
  off: "Uit",
  denied: "Geblokkeerd in je browserinstellingen",
  unsupported: "Niet beschikbaar in deze browser",
  "ios-install": "Uit",
};

function pushGroup(status) {
  const row = (act, ic, label, cls = "") =>
    `<button type="button" class="list-row ${cls}" data-act="${act}"><span class="lead-ic">${icon(ic)}</span><span class="grow">${label}</span></button>`;
  const head = `<div class="list-row static"><span class="lead-ic">${icon("bell")}</span><span class="grow">Status</span>
    <span class="hint push-state ${status === "on" ? "is-on" : ""}">${status ? PUSH_TEXT[status] : "…"}</span></div>`;
  let body = "";
  if (status === "on") body = row("push-test", "send", "Testmelding sturen") + row("push-off", "ban", "Uitzetten op dit apparaat");
  else if (status === "off") body = row("push-on", "bell", "Meldingen aanzetten", "accent");
  else if (status === "denied") body = `<p class="list-note">Sta meldingen voor deze site toe in de instellingen van je browser. Kom daarna terug en zet ze hier aan.</p>`;
  else if (status === "ios-install") body = `<p class="list-note">Zet Nota eerst op je beginscherm (Deel → Zet op beginscherm) en open hem van daaruit. Alleen dan kan iOS meldingen sturen.</p>`;
  else if (status === "unsupported") body = `<p class="list-note">Probeer een andere browser, of zet Nota op je beginscherm.</p>`;
  return head + body;
}

let pushBusy = false;
async function refreshPushGroup(root) {
  const status = await pushStatus();
  const box = (root || document).querySelector("[data-push]");
  if (box && !pushBusy) box.innerHTML = pushGroup(status);
  updateDigest(root);
}

async function pushAction(act, btn) {
  if (pushBusy) return;
  pushBusy = true;
  btn.disabled = true;
  try {
    if (act === "push-on") {
      // enablePush() vraagt meteen toestemming, nog binnen de tik.
      try { await enablePush(); toast("Meldingen staan aan"); }
      catch (e) { toast("Aanzetten lukte niet: " + (e.message || e)); }
    } else if (act === "push-test") {
      try {
        const n = await sendTestPush();
        toast(n ? "Testmelding verstuurd" : "Geen apparaat gevonden om naar te sturen. Zet meldingen opnieuw aan.");
      } catch (e) { toast("Testmelding mislukt: " + (e.message || e)); }
    } else if (act === "push-off") {
      try { await disablePush(); toast("Meldingen staan uit op dit apparaat"); }
      catch (e) { toast("Uitzetten lukte niet: " + (e.message || e)); }
    }
  } finally {
    pushBusy = false;
    btn.disabled = false;
    refreshPushGroup();
  }
}

// ---------- Ochtendoverzicht ----------
function digestGroup() {
  const s = settings();
  const push = cachedPushStatus();
  return `
    <label class="list-row static two-line" for="digest-on">
      <span class="lead-ic">${icon("sun")}</span>
      <span class="grow"><span>Ochtendoverzicht</span><small>Elke ochtend een melding met je taken voor vandaag</small></span>
      <input type="checkbox" class="switch" id="digest-on" ${s.digest_enabled ? "checked" : ""}>
    </label>
    <div class="list-row static ${s.digest_enabled ? "" : "muted"}" data-digest-time>
      <span class="lead-ic">${icon("clock")}</span>
      <label class="grow" for="digest-time">Tijd</label>
      <span class="time-pill" data-act="digest-time-open">
        <span class="time-text">${escapeHtml(s.digest_time)}</span>
        <input type="time" id="digest-time" step="300" value="${escapeHtml(s.digest_time)}" aria-label="Tijd van het ochtendoverzicht">
      </span>
    </div>
    ${push && push !== "on" ? `<p class="list-note" data-digest-hint>Zet eerst meldingen aan. Je krijgt het overzicht op elk apparaat waar meldingen aanstaan.</p>` : ""}`;
}

function updateDigest(root) {
  const box = (root || document).querySelector("[data-digest]");
  if (!box) return;
  if (!box.contains(document.activeElement)) { box.innerHTML = digestGroup(); return; }
  // Veld heeft focus: niet opnieuw opbouwen, alleen waarden bijwerken.
  const s = settings();
  box.querySelector("#digest-on").checked = s.digest_enabled;
  box.querySelector(".time-text").textContent = s.digest_time;
  box.querySelector("[data-digest-time]").classList.toggle("muted", !s.digest_enabled);
}

// ---------- Agenda ----------
export function agendaUrl(token) {
  return `${SUPABASE_URL}/functions/v1/agenda?token=${encodeURIComponent(token)}`;
}

export function webcalUrl(token) {
  return "webcal://" + agendaUrl(token).replace(/^https?:\/\//, "");
}

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function agendaGroup() {
  const token = settings().calendar_token;
  const btn = (act, ic, label, cls = "") =>
    `<button type="button" class="list-row ${cls}" data-act="${act}"><span class="lead-ic">${icon(ic)}</span><span class="grow">${label}</span></button>`;
  const head = `<div class="list-row static"><span class="lead-ic">${icon("calendar")}</span><span class="grow">Agenda-link</span>
    <span class="hint push-state ${token ? "is-on" : ""}">${token ? "Aan" : "Uit"}</span></div>`;
  if (!token) {
    return head + `<p class="list-note">Zie je taken met een datum in Apple Agenda of Google Agenda.</p>` +
      btn("cal-create", "plus", "Agenda-link maken", "accent");
  }
  return head + `
    <p class="list-note">Je taken met een datum verschijnen in je agenda. Wijzigingen komen er binnen een paar uur in.</p>
    <a class="list-row accent" href="${escapeHtml(webcalUrl(token))}" data-cal-apple><span class="lead-ic">${icon("plus")}</span><span class="grow">Toevoegen aan Apple Agenda</span></a>
    ${btn("cal-copy", "copy", "Link kopiëren")}
    <p class="list-note">Google Agenda: ga op een computer naar Instellingen &gt; Agenda toevoegen &gt; Via URL en plak de link.</p>
    ${btn("cal-new", "refresh", "Nieuwe link maken")}
    ${btn("cal-off", "ban", "Agenda-link uitzetten", "danger")}`;
}

async function agendaAction(act) {
  const token = settings().calendar_token;
  if (act === "cal-create") {
    if (await saveSettings({ calendar_token: newToken() })) toast("Agenda-link gemaakt");
  }
  if (act === "cal-copy" && token) {
    try { await navigator.clipboard.writeText(agendaUrl(token)); toast("Link gekopieerd"); }
    catch { toast("Kopiëren lukte niet."); }
  }
  if (act === "cal-new") {
    const ok = await confirmSheet({ title: "Nieuwe link maken?", text: "De oude link werkt daarna niet meer.", ok: "Nieuwe link maken" });
    if (ok && await saveSettings({ calendar_token: newToken() })) toast("Nieuwe link gemaakt. Voeg hem opnieuw toe aan je agenda.");
  }
  if (act === "cal-off") {
    const ok = await confirmSheet({ title: "Agenda-link uitzetten?", text: "Je agenda laat je taken daarna niet meer zien.", ok: "Uitzetten" });
    if (ok && await saveSettings({ calendar_token: null })) toast("Agenda-link staat uit");
  }
}

// ---------- Computer ----------
function computerRow() {
  const st = pcState();
  const info = state.pcStatus?.info || {};
  let sub = "…", hint = "", cls = "";
  if (st === "online") {
    const q = Number(info.queue) || 0;
    sub = q ? `Verwerkt je opnames · ${q} in de wachtrij` : "Verwerkt je opnames";
    hint = "Aan"; cls = "is-on";
  } else if (st === "offline") {
    const ago = agoText(state.pcStatus.last_seen);
    sub = ago ? "Laatst gezien " + ago : "Staat uit";
    hint = "Uit";
  } else if (st === "missing") {
    sub = "Nog niet verbonden"; hint = "Uit";
  }
  return `<div class="list-row static two-line" data-pc-state="${st || "unknown"}">
    <span class="lead-ic">${icon("monitor")}</span>
    <span class="grow"><span>Computer</span><small>${escapeHtml(sub)}</small></span>
    ${hint ? `<span class="hint push-state ${cls}"><span class="pc-dot ${st === "online" ? "is-online" : ""}" aria-hidden="true"></span>${hint}</span>` : ""}
  </div>`;
}

export async function changePassword({ recovery = false } = {}) {
  const pw = await promptSheet({
    title: recovery ? "Nieuw wachtwoord" : "Wachtwoord wijzigen",
    sub: recovery ? "Kies een nieuw wachtwoord voor je account." : "Minimaal 8 tekens.",
    type: "password", placeholder: "Nieuw wachtwoord", ok: "Opslaan", autocomplete: "new-password",
  });
  if (!pw) return;
  if (pw.length < 8) { toast("Kies minimaal 8 tekens."); return changePassword({ recovery }); }
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) toast("Wijzigen mislukt: " + error.message);
  else toast("Wachtwoord gewijzigd");
}

function exportTasks() {
  const rows = [["titel", "project", "sectie", "prioriteit", "datum", "tijd", "herhaling", "deadline", "labels", "voltooid", "beschrijving"]];
  const tasks = [...state.tasks.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const t of tasks) {
    rows.push([t.title, projectById(t.project_id)?.name || "Inbox", sectionById(t.section_id)?.name || "", "p" + (t.priority || 4),
      t.due_date || "", t.due_time || "", t.recurrence?.text || "", t.deadline || "", (t.labels || []).join(", "),
      t.completed ? (t.completed_at || "ja") : "", t.description || ""]);
  }
  downloadBlob("﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n"), "nota-taken.csv", "text/csv");
}
