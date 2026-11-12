// Snel toevoegen: één tekstveld dat live laat zien wat er herkend wordt
// (datum, #project, @label, p1 ...). Techniek: een gespiegelde div met
// gekleurde stukjes achter een textarea met doorzichtige tekst. Dat is op
// iOS Safari veel betrouwbaarder dan contenteditable.

import { parseQuickAdd, formatDue } from "./parse.js";
import { openSheet, escapeHtml, icon, toast, actions } from "./ui.js";
import {
  state, activeProjects, projectById, sectionById, sectionsOf, createTask, createProject,
  createSection, ensureLabels, labelByName,
} from "./store.js";
import { dateSheet, prioritySheet, labelsSheet, projectSheet, safeDescribe } from "./pickers.js";
import { PRIORITIES, shortDate } from "./tasks.js";

const TYPE_FIELDS = {
  due: ["date", "time", "recurrence"],
  project: ["project", "section"],
  priority: ["priority"],
  labels: ["label"],
  deadline: ["deadline"],
};

let openInstance = null;

export function openQuickAdd(ctx = {}) {
  if (openInstance && !openInstance.closed) { openInstance.q(".qa-input").focus(); return; }
  const defaults = () => ({
    due: ctx.due_date ? { due_date: ctx.due_date, due_time: null, recurrence: null } : null,
    priority: null,
    labels: ctx.labels ? [...ctx.labels] : [],
    deadline: null,
  });
  let manual = { ...defaults(), project: ctx.project_id !== undefined ? { project_id: ctx.project_id || null, section_id: ctx.section_id || null } : null };
  const parent = ctx.parent_id ? state.tasks.get(ctx.parent_id) : null;

  const sh = openSheet({
    label: parent ? "Subtaak toevoegen" : "Taak toevoegen",
    className: "quickadd kb-aware",
    html: `
      ${parent ? `<p class="qa-parent">${icon("subtask", "icon-xs")}Subtaak van <b>${escapeHtml(parent.title)}</b></p>` : ""}
      <div class="qa-field">
        <div class="qa-mirror" aria-hidden="true"></div>
        <textarea class="qa-input" rows="1" placeholder="Bijv. Offerte sturen vrijdag 10u p1 #Werk" aria-label="Taak" enterkeyhint="send" autocapitalize="sentences"></textarea>
      </div>
      <textarea class="qa-desc" rows="1" placeholder="Beschrijving" aria-label="Beschrijving"></textarea>
      <div class="qa-chips chips" role="group" aria-label="Eigenschappen"></div>
      <div class="qa-bar">
        <button type="button" class="icon-btn qa-mic" aria-label="Spraaknotitie opnemen">${icon("mic")}</button>
        <span class="qa-hint"></span>
        <button type="button" class="qa-add" disabled aria-label="Toevoegen">${icon("send")}<span>Toevoegen</span></button>
      </div>`,
    onClose: () => { openInstance = null; },
  });
  openInstance = sh;
  const input = sh.q(".qa-input");
  const mirror = sh.q(".qa-mirror");
  const desc = sh.q(".qa-desc");
  const chips = sh.q(".qa-chips");
  const addBtn = sh.q(".qa-add");
  let parsed = null;

  const parse = () => parseQuickAdd(input.value, {
    now: new Date(),
    projects: activeProjects().map((p) => ({ id: p.id, name: p.name })),
    labels: state.labels.map((l) => l.name),
  });

  function effective() {
    const p = parsed;
    const due = p.due_date || p.recurrence ? { due_date: p.due_date, due_time: p.due_time, recurrence: p.recurrence } : manual.due;
    let project;
    if (p.project) project = { project_id: p.project.id, section_id: null, name: p.project.name };
    else if (p.new_project) project = { project_id: null, section_id: null, name: p.new_project, isNew: true };
    else if (manual.project) project = { ...manual.project };
    else project = { project_id: null, section_id: null };
    if (p.section) project.sectionName = p.section;
    const labels = [...new Set([...manual.labels, ...p.labels])];
    return {
      due, project, labels,
      priority: p.priority ?? manual.priority ?? 4,
      deadline: p.deadline ?? manual.deadline,
      duration_min: p.duration_min,
      reminder: p.reminder,
    };
  }

  function autosize(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }

  function renderMirror() {
    const text = input.value;
    const toks = [...parsed.tokens].sort((a, b) => a.start - b.start);
    let html = "", i = 0;
    for (const t of toks) {
      if (t.start < i) continue;
      html += escapeHtml(text.slice(i, t.start));
      html += `<span class="tok tok-${t.type}">${escapeHtml(text.slice(t.start, t.end))}</span>`;
      i = t.end;
    }
    html += escapeHtml(text.slice(i));
    // Afsluitende spatie/regel zichtbaar houden, anders loopt de hoogte achter.
    mirror.innerHTML = html + "​";
  }

  function renderChips() {
    const e = effective();
    const out = [];
    // Datum
    if (e.due && e.due.due_date) {
      const d = formatDue(e.due.due_date, e.due.due_time, new Date());
      out.push(`<button type="button" class="chip qa-chip set tone-${d.tone}" data-k="due">${icon(e.due.recurrence ? "repeat" : "calendar", "icon-sm")}${escapeHtml(d.text)}${e.due.recurrence ? `<span class="chip-sub">${escapeHtml(safeDescribe(e.due.recurrence).toLowerCase())}</span>` : ""}</button>`);
    } else {
      out.push(`<button type="button" class="chip qa-chip" data-k="due">${icon("calendar", "icon-sm")}Datum</button>`);
    }
    // Project
    if (!parent) {
      const pr = e.project;
      let name = "Inbox", color = null;
      if (pr.isNew) name = pr.name + " (nieuw)";
      else if (pr.project_id) { const p = projectById(pr.project_id); name = p ? p.name : "Project"; color = p?.color; }
      const sec = pr.sectionName || (pr.section_id ? sectionById(pr.section_id)?.name : null);
      out.push(`<button type="button" class="chip qa-chip ${pr.project_id || pr.isNew ? "set" : ""}" data-k="project">${color ? `<span class="dot" style="--c:${escapeHtml(color)}"></span>` : icon(pr.isNew ? "plus" : "inbox", "icon-sm")}${escapeHtml(name)}${sec ? ` / ${escapeHtml(sec)}` : ""}</button>`);
    }
    // Prioriteit
    const pr = PRIORITIES.find((x) => x.p === e.priority);
    out.push(`<button type="button" class="chip qa-chip ${e.priority < 4 ? "set" : ""}" data-k="priority" style="${e.priority < 4 ? `--pc:${pr.color}` : ""}">${icon(e.priority < 4 ? "flag-fill" : "flag", "icon-sm")}${e.priority < 4 ? "P" + e.priority : "Prioriteit"}</button>`);
    // Labels
    out.push(`<button type="button" class="chip qa-chip ${e.labels.length ? "set" : ""}" data-k="labels">${icon("tag", "icon-sm")}${e.labels.length ? escapeHtml(e.labels.join(", ")) : "Labels"}</button>`);
    // Deadline
    out.push(`<button type="button" class="chip qa-chip ${e.deadline ? "set" : ""}" data-k="deadline">${icon("target", "icon-sm")}${e.deadline ? "Deadline " + escapeHtml(shortDate(e.deadline)) : "Deadline"}</button>`);
    if (e.duration_min) out.push(`<span class="chip qa-chip set static">${icon("hourglass", "icon-sm")}${e.duration_min} min</span>`);
    if (e.reminder) out.push(`<span class="chip qa-chip set static">${icon("bell", "icon-sm")}${escapeHtml(reminderText(e.reminder))}</span>`);
    chips.innerHTML = out.join("");
  }

  function update() {
    parsed = parse();
    renderMirror();
    renderChips();
    autosize(input);
    addBtn.disabled = !parsed.title;
  }

  // Tekst van bepaalde typen tokens uit het veld halen (bij handmatig kiezen).
  function stripTokens(types) {
    const toks = parsed.tokens.filter((t) => types.includes(t.type)).sort((a, b) => b.start - a.start);
    if (!toks.length) return;
    let v = input.value;
    for (const t of toks) v = v.slice(0, t.start) + v.slice(t.end);
    input.value = v.replace(/\s{2,}/g, " ").replace(/^\s+/, "");
    update();
  }

  input.addEventListener("input", update);
  input.addEventListener("scroll", () => { mirror.scrollTop = input.scrollTop; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  desc.addEventListener("input", () => autosize(desc));
  desc.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });

  chips.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    const eff = effective();
    const k = b.dataset.k;
    if (k === "due") {
      const r = await dateSheet({ ...(eff.due || {}) });
      if (r) { stripTokens(TYPE_FIELDS.due); manual.due = r.due_date ? r : null; }
    } else if (k === "project") {
      const r = await projectSheet({ project_id: eff.project.project_id, section_id: eff.project.section_id });
      if (r) { stripTokens(TYPE_FIELDS.project); manual.project = r; }
    } else if (k === "priority") {
      const r = await prioritySheet(eff.priority);
      if (r) { stripTokens(TYPE_FIELDS.priority); manual.priority = r; }
    } else if (k === "labels") {
      const r = await labelsSheet(eff.labels);
      if (r) { stripTokens(TYPE_FIELDS.labels); manual.labels = r; }
    } else if (k === "deadline") {
      const r = await dateSheet({ due_date: eff.deadline, mode: "deadline" });
      if (r) { stripTokens(TYPE_FIELDS.deadline); manual.deadline = r.due_date; }
    }
    update();
    if (!sh.closed) input.focus({ preventScroll: true });
  });

  sh.q(".qa-mic").addEventListener("click", () => {
    const eff = effective();
    const p = eff.project.project_id ? projectById(eff.project.project_id) : null;
    actions.record({ project_id: p ? p.id : null });
  });

  addBtn.addEventListener("click", () => submit());

  let busy = false;
  async function submit() {
    update();
    if (!parsed.title || busy) { input.focus(); return; }
    busy = true;
    const e = effective();
    try {
      let project_id = e.project.project_id || null;
      let section_id = e.project.section_id || null;
      if (parent) { project_id = parent.project_id; section_id = parent.section_id; }
      else if (e.project.isNew) {
        const p = await createProject({ name: e.project.name });
        if (!p) return;
        project_id = p.id; section_id = null;
      }
      if (e.project.sectionName && project_id && !parent) {
        const n = e.project.sectionName.toLowerCase();
        let s = sectionsOf(project_id).find((x) => x.name.toLowerCase() === n) ||
          sectionsOf(project_id).find((x) => x.name.toLowerCase().startsWith(n));
        if (!s) s = await createSection(project_id, e.project.sectionName);
        section_id = s ? s.id : null;
      }
      if (e.labels.length) await ensureLabels(e.labels);
      const labels = e.labels.map((n) => labelByName(n)?.name || n);
      const fields = {
        title: parsed.title,
        description: desc.value.trim(),
        project_id, section_id,
        parent_id: parent ? parent.id : null,
        priority: e.priority,
        due_date: e.due?.due_date || null,
        due_time: e.due?.due_time || null,
        recurrence: e.due?.recurrence || null,
        deadline: e.deadline || null,
        duration_min: e.duration_min || null,
        labels,
        reminder_at: reminderAt(e.reminder, e.due),
      };
      const t = await createTask(fields);
      if (!t) return;
      // Todoist-gedrag: sheet blijft open voor de volgende taak, project blijft staan.
      input.value = "";
      desc.value = "";
      autosize(desc);
      const keepProject = e.project.isNew ? { project_id, section_id: null } : (manual.project || (e.project.project_id ? { project_id, section_id } : null));
      manual = { ...defaults(), project: keepProject };
      update();
      const where = parent ? "subtaken" : project_id ? (projectById(project_id)?.name || "project") : "Inbox";
      toast(`Toegevoegd aan ${where}`, { action: { label: "Openen", fn: () => { sh.close(); actions.openTask(t.id); } } });
      input.focus({ preventScroll: true });
    } finally {
      busy = false;
    }
  }

  if (ctx.text) input.value = ctx.text;
  update();
  input.focus({ preventScroll: true });
  return sh;
}

function reminderText(r) {
  if (r.at) {
    const [d, t] = r.at.split("T");
    return `Herinnering ${formatDue(d, null, new Date()).text.toLowerCase()} ${t}`;
  }
  if (r.minutes_before != null) {
    const m = r.minutes_before;
    return `Herinnering ${m >= 1440 ? m / 1440 + " d" : m >= 60 ? m / 60 + " u" : m + " min"} vooraf`;
  }
  return "Herinnering";
}

function reminderAt(r, due) {
  if (!r) return null;
  try {
    if (r.at) return new Date(r.at).toISOString();
    if (r.minutes_before != null && due && due.due_date) {
      const base = new Date(`${due.due_date}T${due.due_time || "09:00"}`);
      return new Date(base.getTime() - r.minutes_before * 60000).toISOString();
    }
  } catch {}
  return null;
}
