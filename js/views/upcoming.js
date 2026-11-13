// Binnenkort: weekstrip bovenaan + per dag de taken voor de komende 30 dagen.

import { todayStr, addDays, fromDateStr } from "../parse.js";
import { escapeHtml, capitalize, menuSheet } from "../ui.js";
import { openTasks } from "../store.js";
import { taskList, sortByTimePrio } from "../tasks.js";
import { addInline, groupHead, WD_SHORT, MONTH_SHORT, MONTH_LONG } from "./common.js";
import { rescheduleOverdue } from "./today.js";

const DAYS = 30;
const STRIP_DAYS = 35;
let selected = null;

function dayTitle(ds, today) {
  const d = fromDateStr(ds);
  const base = `${WD_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  if (ds === today) return `Vandaag <span>· ${base}</span>`;
  if (ds === addDays(today, 1)) return `Morgen <span>· ${base}</span>`;
  const long = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"][d.getDay()];
  return `${capitalize(long)} <span>· ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}</span>`;
}

function monthLabel(ds) {
  const d = fromDateStr(ds);
  return `${capitalize(MONTH_LONG[d.getMonth()])}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`;
}

function strip(today, busy) {
  let html = "";
  for (let i = 0; i < STRIP_DAYS; i++) {
    const ds = addDays(today, i);
    const d = fromDateStr(ds);
    html += `<button type="button" class="day ${ds === selected ? "sel" : ""} ${ds === today ? "is-today" : ""} ${d.getDay() === 1 && i ? "wk" : ""}" data-act="day" data-date="${ds}" aria-pressed="${ds === selected}" aria-label="${dayTitle(ds, today).replace(/<[^>]+>/g, "")}">
      <span class="wd">${WD_SHORT[d.getDay()]}</span><span class="dn">${d.getDate()}</span><i class="${busy.has(ds) ? "on" : ""}"></i>
    </button>`;
  }
  return `<div class="strip-wrap"><p class="strip-month">${monthLabel(selected)}</p><div class="strip" role="group" aria-label="Dagen">${html}</div></div>`;
}

export default {
  tab: "binnenkort",
  topbar() {
    const today = todayStr();
    if (!selected || selected < today) selected = today;
    const busy = new Set(openTasks().map((t) => t.due_date).filter(Boolean));
    return {
      title: "Binnenkort",
      fixedTitle: true,
      actions: [{ act: "search", icon: "search", label: "Zoeken" }, { act: "menu", icon: "more", label: "Weergave-opties" }],
      extra: strip(today, busy),
    };
  },
  context: () => ({ due_date: selected || todayStr() }),

  render() {
    const today = todayStr();
    const end = addDays(today, DAYS - 1);
    const open = openTasks();
    const overdue = open.filter((t) => t.due_date && t.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date) || sortByTimePrio(a, b));
    let html = "";
    if (overdue.length) {
      html += `<section class="group">
        ${groupHead("Achterstallig", { count: overdue.length, cls: "tone-overdue-head", right: `<button type="button" class="link-btn" data-act="reschedule">Opnieuw plannen</button>` })}
        <div class="card">${taskList(overdue, { showProject: true })}</div>
      </section>`;
    }
    const byDay = new Map();
    open.forEach((t) => {
      if (t.due_date && t.due_date >= today && t.due_date <= end) {
        if (!byDay.has(t.due_date)) byDay.set(t.due_date, []);
        byDay.get(t.due_date).push(t);
      }
    });
    for (let i = 0; i < DAYS; i++) {
      const ds = addDays(today, i);
      const list = (byDay.get(ds) || []).sort(sortByTimePrio);
      html += `<section class="group day-group" data-day="${ds}" id="day-${ds}">
        ${groupHead(dayTitle(ds, today), { count: list.length || null })}
        ${list.length ? `<div class="card">${taskList(list, { showProject: true })}</div>` : ""}
        ${addInline(`data-date="${ds}"`)}
      </section>`;
    }
    const later = open.filter((t) => t.due_date && t.due_date > end).length;
    if (later) html += `<p class="footnote">Nog ${later} ${later === 1 ? "taak" : "taken"} na ${fromDateStr(end).getDate()} ${MONTH_SHORT[fromDateStr(end).getMonth()]}.</p>`;
    return html;
  },

  async onClick(act, el) {
    if (act === "day") { select(el.dataset.date, true); return; }
    if (act === "reschedule") return rescheduleOverdue();
    if (act === "menu") {
      const r = await menuSheet({ groups: [{ items: [
        { id: "today", label: "Naar vandaag", icon: "today" },
        { id: "reschedule", label: "Achterstallige naar vandaag", icon: "calendar" },
        { id: "refresh", label: "Vernieuwen", icon: "refresh" },
      ] }] });
      if (r === "today") select(todayStr(), true);
      if (r === "reschedule") rescheduleOverdue();
      if (r === "refresh") return "refresh";
    }
  },

  // Tijdens scrollen de geselecteerde dag in de strip meeschuiven.
  onScroll() {
    const bar = document.getElementById("topbar");
    const top = bar.getBoundingClientRect().bottom + 12;
    let cur = null;
    document.querySelectorAll(".day-group").forEach((g) => { if (g.getBoundingClientRect().top <= top) cur = g.dataset.day; });
    if (!cur) cur = todayStr();
    if (cur !== selected && !scrollingTo) select(cur, false);
  },
};

let scrollingTo = null;
function select(ds, scroll) {
  selected = ds;
  document.querySelectorAll(".strip .day").forEach((b) => {
    const on = b.dataset.date === ds;
    b.classList.toggle("sel", on);
    b.setAttribute("aria-pressed", String(on));
    if (on && !scroll) b.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
  const m = document.querySelector(".strip-month");
  if (m) m.textContent = monthLabel(ds);
  if (scroll) {
    const g = document.getElementById("day-" + ds);
    if (!g) return;
    // Rijen boven de gekozen dag echt laten opmaken (ze staan op
    // content-visibility: auto), anders klopt de doelpositie niet.
    const groups = [...document.querySelectorAll("#view .group")];
    const above = groups.slice(0, groups.indexOf(g));
    above.forEach((x) => x.classList.add("cv-off"));
    const bar = document.getElementById("topbar");
    const y = g.getBoundingClientRect().top + scrollY - bar.offsetHeight - 4;
    scrollingTo = ds;
    window.scrollTo({ top: ds === todayStr() ? 0 : y, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    clearTimeout(select.t);
    select.t = setTimeout(() => { scrollingTo = null; above.forEach((x) => x.classList.remove("cv-off")); }, 700);
  }
}
