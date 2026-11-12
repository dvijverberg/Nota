// Vandaag: achterstallig (met "Opnieuw plannen") + de taken van vandaag.

import { todayStr, fromDateStr } from "../parse.js";
import { escapeHtml, icon, toast, menuSheet, capitalize } from "../ui.js";
import { openTasks, updateTask, updateTasks, projectById, activeProjects } from "../store.js";
import { taskList, sortByTimePrio } from "../tasks.js";
import { intro, emptyState, groupHead, getPref, setPref, WD_SHORT, MONTH_SHORT } from "./common.js";

export function todayLabel(now = new Date()) {
  return `${capitalize(WD_SHORT[now.getDay()])} ${now.getDate()} ${MONTH_SHORT[now.getMonth()]}`;
}

export default {
  tab: "vandaag",
  topbar: () => ({
    title: "Vandaag",
    actions: [{ act: "search", icon: "search", label: "Zoeken" }, { act: "menu", icon: "more", label: "Weergave-opties" }],
  }),
  context: () => ({ due_date: todayStr() }),

  render() {
    const today = todayStr();
    const open = openTasks();
    const overdue = open.filter((t) => t.due_date && t.due_date < today)
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || sortByTimePrio(a, b));
    const todays = open.filter((t) => t.due_date === today).sort(sortByTimePrio);
    const n = overdue.length + todays.length;
    let html = intro("Vandaag", `${todayLabel()}${n ? ` · ${n} ${n === 1 ? "taak" : "taken"}` : ""}`);

    if (overdue.length) {
      html += `<section class="group">
        ${groupHead("Achterstallig", { count: overdue.length, cls: "tone-overdue-head", right: `<button type="button" class="link-btn" data-act="reschedule">Opnieuw plannen</button>` })}
        <div class="card">${taskList(overdue, { showProject: true })}</div>
      </section>`;
    }

    if (todays.length) {
      if (getPref("today-group", false)) {
        const groups = new Map();
        todays.forEach((t) => {
          const k = t.project_id || "";
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(t);
        });
        const order = ["", ...activeProjects().map((p) => p.id)];
        [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b)).forEach((k) => {
          const p = k ? projectById(k) : null;
          html += `<section class="group">
            ${groupHead(`${p ? `<span class="pdot" style="--c:${escapeHtml(p.color)}"></span>` : ""}${escapeHtml(p ? p.name : "Inbox")}`, { count: groups.get(k).length })}
            <div class="card">${taskList(groups.get(k), { showProject: false, hideToday: true })}</div>
          </section>`;
        });
      } else {
        html += `<section class="group">
          ${overdue.length ? groupHead("Vandaag", { count: todays.length }) : ""}
          <div class="card">${taskList(todays, { showProject: true, hideToday: true })}</div>
        </section>`;
      }
    }

    if (!n) {
      html += emptyState("Niets meer voor vandaag.", "Nieuwe taak? Tik op de plusknop.");
    }
    return html;
  },

  async onClick(act) {
    if (act === "reschedule") return rescheduleOverdue();
    if (act === "menu") {
      const grouped = getPref("today-group", false);
      const r = await menuSheet({
        groups: [
          { label: "Weergave", items: [
            { id: "flat", label: "Op tijd en prioriteit", icon: "sort", checked: !grouped },
            { id: "group", label: "Per project", icon: "folder", checked: grouped },
          ] },
          { items: [
            { id: "reschedule", label: "Achterstallige naar vandaag", icon: "today" },
            { id: "refresh", label: "Vernieuwen", icon: "refresh" },
          ] },
        ],
      });
      if (r === "flat" || r === "group") { setPref("today-group", r === "group"); return "rerender"; }
      if (r === "reschedule") rescheduleOverdue();
      if (r === "refresh") return "refresh";
    }
  },
};

export async function rescheduleOverdue() {
  const today = todayStr();
  const overdue = openTasks().filter((t) => t.due_date && t.due_date < today);
  if (!overdue.length) { toast("Geen achterstallige taken."); return; }
  const prev = overdue.map((t) => [t.id, t.due_date]);
  const ok = await updateTasks(overdue.map((t) => t.id), { due_date: today });
  if (ok) {
    toast(`${overdue.length} ${overdue.length === 1 ? "taak" : "taken"} naar vandaag`, {
      action: { label: "Ongedaan maken", fn: () => prev.forEach(([id, d]) => updateTask(id, { due_date: d })) },
    });
  }
}
