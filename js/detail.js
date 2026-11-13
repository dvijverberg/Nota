// Taakdetails: hoge sheet waarin alles direct bewerkbaar is. Elke
// wijziging gaat meteen naar Supabase (optimistisch, terugdraaien bij fout).

import { formatDue, formatDateLong, todayStr } from "./parse.js";
import { openSheet, escapeHtml, icon, toast, confirmSheet, menuSheet, actions, CHECK_SVG } from "./ui.js";
import {
  state, getTask, projectById, sectionById, childrenOf, updateTask, updateTasks, deleteTask,
  duplicateTask, subscribe, noteById, allTasks, rescheduleTask,
} from "./store.js";
import { dateSheet, prioritySheet, labelsSheet, projectSheet, reminderSheet, describeReminder, safeDescribe } from "./pickers.js";
import { PRIORITIES, taskList, bindTaskInteractions, toggleTask, shortDate, dueInfo } from "./tasks.js";
import { mountComments } from "./comments.js";

const DURATIONS = [0, 5, 10, 15, 30, 45, 60, 90, 120, 180, 240];

export function openTaskDetail(id) {
  const t0 = getTask(id);
  if (!t0) { toast("Deze taak bestaat niet meer."); return; }
  const base = location.href.split("#")[0];
  const sh = openSheet({
    label: "Taak",
    className: "tall detail",
    url: `${base}#/taak/${id}`,
    html: `
      <div class="detail-head">
        <button type="button" class="crumb" data-a="project"></button>
        <span class="grow"></span>
        <button type="button" class="icon-btn" data-a="more" aria-label="Meer acties">${icon("more")}</button>
        <button type="button" class="icon-btn" data-a="close" aria-label="Sluiten">${icon("x")}</button>
      </div>
      <div class="sheet-scroll detail-scroll">
        <div class="detail-parent"></div>
        <div class="detail-title-row">
          <button type="button" class="check big" data-a="check">${CHECK_SVG}</button>
          <textarea class="detail-title" rows="1" aria-label="Titel" enterkeyhint="done"></textarea>
        </div>
        <textarea class="detail-desc" rows="2" placeholder="Beschrijving" aria-label="Beschrijving"></textarea>
        <div class="detail-props"></div>
        <div class="detail-note"></div>
        <div class="detail-subs">
          <p class="sheet-label">Subtaken <span class="sub-count"></span></p>
          <div class="subs-list"></div>
          <button type="button" class="add-inline" data-a="add-sub">${icon("plus", "icon-sm")}Subtaak toevoegen</button>
        </div>
        <p class="detail-meta"></p>
      </div>`,
    onClose: () => { unsub(); flush(); comments.destroy(); },
  });
  const comments = mountComments(sh, id);

  const titleEl = sh.q(".detail-title");
  const descEl = sh.q(".detail-desc");
  const autosize = (el) => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };

  const task = () => getTask(id);
  titleEl.value = t0.title;
  descEl.value = t0.description || "";

  // Automatisch opslaan: kort na typen en bij verlaten van het veld.
  let saveTimer = null;
  function flush() {
    clearTimeout(saveTimer);
    const t = task();
    if (!t) return;
    const title = titleEl.value.replace(/\s*\n\s*/g, " ").trim();
    const desc = descEl.value.replace(/\s+$/, "");
    const patch = {};
    if (title && title !== t.title) patch.title = title;
    if (desc !== (t.description || "")) patch.description = desc;
    if (Object.keys(patch).length) updateTask(id, patch);
  }
  const schedule = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); };
  titleEl.addEventListener("input", () => { autosize(titleEl); schedule(); });
  descEl.addEventListener("input", () => { autosize(descEl); schedule(); });
  titleEl.addEventListener("blur", () => { if (!titleEl.value.trim()) titleEl.value = task()?.title || ""; flush(); });
  descEl.addEventListener("blur", flush);
  titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } });

  function propRow(a, ic, label, value, { tone = "", empty = false, clear = false, style = "" } = {}) {
    return `
      <div class="prop">
        <button type="button" class="prop-btn" data-a="${a}">
          <span class="prop-ic ${tone}" style="${style}">${icon(ic)}</span>
          <span class="prop-label">${label}</span>
          <span class="prop-val ${empty ? "is-empty" : ""} ${tone} ${value.includes('class="pill"') ? "pills" : ""}">${value}</span>
        </button>
        ${clear ? `<button type="button" class="icon-btn sm" data-clear="${a}" aria-label="${label} wissen">${icon("x", "icon-sm")}</button>` : ""}
      </div>`;
  }

  function render() {
    const t = task();
    if (!t) { sh.close(); return; }
    const p = t.project_id ? projectById(t.project_id) : null;
    const s = t.section_id ? sectionById(t.section_id) : null;
    sh.q('[data-a="project"]').innerHTML = p
      ? `<span class="dot" style="--c:${escapeHtml(p.color)}"></span>${escapeHtml(p.name)}${s ? `<span class="crumb-sep">/</span>${escapeHtml(s.name)}` : ""}${icon("chevron", "icon-xs")}`
      : `${icon("inbox", "icon-sm")}Inbox${icon("chevron", "icon-xs")}`;

    const parent = t.parent_id ? getTask(t.parent_id) : null;
    sh.q(".detail-parent").innerHTML = parent
      ? `<button type="button" class="parent-link" data-open="${parent.id}">${icon("subtask", "icon-xs")}Subtaak van <b>${escapeHtml(parent.title)}</b></button>` : "";

    const check = sh.q('[data-a="check"]');
    check.className = `check big prio-${t.priority || 4}`;
    check.setAttribute("aria-pressed", String(!!t.completed));
    check.setAttribute("aria-label", t.completed ? "Markeer als open" : "Afvinken");
    sh.el.classList.toggle("is-done", !!t.completed);
    if (document.activeElement !== titleEl) titleEl.value = t.title;
    if (document.activeElement !== descEl) descEl.value = t.description || "";
    autosize(titleEl); autosize(descEl);

    const due = dueInfo(t);
    const prio = PRIORITIES.find((x) => x.p === (t.priority || 4));
    const durLabel = (m) => !m ? "Geen" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} u${m % 60 ? " " + (m % 60) + " min" : ""}`;
    const rem = describeReminder(t);

    // Niet opnieuw opbouwen terwijl je in een veld van de eigenschappen zit.
    const props = sh.q(".detail-props");
    if (!props.contains(document.activeElement)) props.innerHTML = `
      <div class="sheet-group props">
        ${propRow("due", t.recurrence ? "repeat" : "calendar", "Datum",
          due ? escapeHtml(due.text) + (t.recurrence ? `<small>${escapeHtml(safeDescribe(t.recurrence))}</small>` : "") : "Geen datum",
          { tone: due ? "tone-" + due.tone : "", empty: !due, clear: !!due })}
        ${propRow("deadline", "target", "Deadline", t.deadline ? escapeHtml(formatDateLong(t.deadline)) : "Geen", { empty: !t.deadline, clear: !!t.deadline, tone: t.deadline && t.deadline < todayStr() ? "tone-overdue" : "" })}
        ${propRow("priority", (t.priority || 4) < 4 ? "flag-fill" : "flag", "Prioriteit", prio.name, { style: `color:${prio.color}`, empty: (t.priority || 4) === 4 })}
        ${propRow("labels", "tag", "Labels", t.labels.length ? t.labels.map((l) => `<span class="pill">${escapeHtml(l)}</span>`).join("") : "Geen", { empty: !t.labels.length })}
        ${propRow("reminder", "bell", "Herinnering", escapeHtml(rem.text), { empty: rem.empty, clear: !!t.reminder_at, tone: rem.past && !t.completed ? "tone-overdue" : "" })}
        <div class="prop">
          <label class="prop-btn">
            <span class="prop-ic">${icon("hourglass")}</span><span class="prop-label">Duur</span>
            <select class="prop-input" data-f="duration" aria-label="Duur">
              ${[...new Set([...DURATIONS, t.duration_min || 0])].sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === (t.duration_min || 0) ? "selected" : ""}>${durLabel(m)}</option>`).join("")}
            </select>
          </label>
        </div>
      </div>`;

    const note = t.note_id ? noteById(t.note_id) : null;
    sh.q(".detail-note").innerHTML = note
      ? `<button type="button" class="note-link" data-note="${note.id}">${icon("mic", "icon-sm")}<span>Uit notitie: <b>${escapeHtml(note.title || "Spraaknotitie")}</b></span>${icon("chevron-right", "icon-sm")}</button>` : "";

    const kids = childrenOf(id);
    sh.q(".sub-count").textContent = kids.length ? `${kids.filter((k) => k.completed).length}/${kids.length}` : "";
    sh.q(".subs-list").innerHTML = taskList(kids, { hideSubCount: false }) || "";
    sh.q(".detail-subs").hidden = !!t.parent_id && !kids.length;

    const created = t.created_at ? new Date(t.created_at) : null;
    const done = t.completed_at ? new Date(t.completed_at) : null;
    const fmt = (d) => d.toLocaleString("nl-NL", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    sh.q(".detail-meta").innerHTML = [
      created && !isNaN(created) ? `Aangemaakt op ${fmt(created)}` : "",
      t.completed && done && !isNaN(done) ? `Voltooid op ${fmt(done)}` : "",
    ].filter(Boolean).join("<br>");
  }

  // Subtaken: tikken opent de subtaak, vinkje vinkt af (blijft zichtbaar).
  bindTaskInteractions(sh.q(".subs-list"), { gestures: false, keepVisible: () => true });

  sh.el.addEventListener("change", (e) => {
    const f = e.target.dataset.f;
    if (f === "duration") {
      const m = Number(e.target.value);
      updateTask(id, { duration_min: m || null });
    }
  });

  sh.el.addEventListener("click", async (e) => {
    const t = task();
    if (!t) return;
    const clr = e.target.closest("[data-clear]");
    if (clr) {
      const k = clr.dataset.clear;
      // Focus weg, anders bouwt render() de eigenschappen niet opnieuw op.
      clr.blur();
      if (k === "due") rescheduleTask(id, { due_date: null, due_time: null, recurrence: null });
      if (k === "deadline") updateTask(id, { deadline: null });
      if (k === "reminder") updateTask(id, { reminder_at: null });
      return;
    }
    const op = e.target.closest("[data-open]");
    if (op) { actions.openTask(op.dataset.open); return; }
    const nl = e.target.closest("[data-note]");
    if (nl) { const nid = nl.dataset.note; sh.close(); setTimeout(() => actions.openNote(nid), 30); return; }
    const a = e.target.closest("[data-a]");
    if (!a) return;
    switch (a.dataset.a) {
      case "close": sh.close(); break;
      case "check": toggleTask(id, null, { keepVisible: true }); break;
      case "project": {
        const r = await projectSheet({ project_id: t.project_id, section_id: t.section_id });
        if (!r) break;
        const patch = { project_id: r.project_id, section_id: r.section_id };
        if (t.parent_id && (r.project_id !== t.project_id || r.section_id !== t.section_id)) patch.parent_id = null;
        await updateTask(id, patch);
        const kids = allTasks().filter((x) => x.parent_id === id).map((x) => x.id);
        if (kids.length) updateTasks(kids, { project_id: r.project_id, section_id: r.section_id });
        break;
      }
      case "due": {
        const r = await dateSheet({ due_date: t.due_date, due_time: t.due_time, recurrence: t.recurrence });
        if (r) rescheduleTask(id, { due_date: r.due_date, due_time: r.due_date ? r.due_time : null, recurrence: r.due_date ? r.recurrence : null });
        break;
      }
      case "reminder": {
        const r = await reminderSheet(t);
        if (r) updateTask(id, { reminder_at: r.reminder_at });
        break;
      }
      case "deadline": {
        const r = await dateSheet({ due_date: t.deadline, mode: "deadline" });
        if (r) updateTask(id, { deadline: r.due_date });
        break;
      }
      case "priority": {
        const r = await prioritySheet(t.priority || 4);
        if (r) updateTask(id, { priority: r });
        break;
      }
      case "labels": {
        const r = await labelsSheet(t.labels);
        if (r) updateTask(id, { labels: r });
        break;
      }
      case "add-sub": actions.quickAdd({ parent_id: id }); break;
      case "more": {
        const r = await menuSheet({
          groups: [
            { items: [{ id: "dup", label: "Dupliceren", icon: "copy" }] },
            { items: [{ id: "del", label: "Verwijderen", icon: "trash", danger: true }] },
          ],
        });
        if (r === "dup") {
          flush();
          const c = await duplicateTask(id);
          if (c) toast("Taak gedupliceerd", { action: { label: "Openen", fn: () => actions.openTask(c.id) } });
        } else if (r === "del") {
          const kids = childrenOf(id).length;
          const ok = await confirmSheet({
            title: "Taak verwijderen?",
            text: `“${t.title}”${kids ? ` en ${kids} ${kids === 1 ? "subtaak" : "subtaken"}` : ""} wordt definitief verwijderd.`,
          });
          if (ok) {
            sh.close();
            if (await deleteTask(id)) toast("Taak verwijderd");
          }
        }
        break;
      }
    }
  });

  const unsub = subscribe(render);
  render();
  return sh;
}
