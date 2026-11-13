// Productiviteit: dagdoel, reeks, deze week, per project, recent voltooid
// en de doelen zelf.

import { escapeHtml, icon, actions, capitalize } from "../ui.js";
import { getTask, projectById, saveSettings, settings, agoText } from "../store.js";
import {
  completionsLoaded, loadCompletions, completionRows, todayCount, streaks, weekDays, lastWeeks,
  weekRows, goals, pulsing,
} from "../completions.js";
import { intro, getPref, setPref, WD_SHORT, MONTH_SHORT } from "./common.js";

const DAY_NAMES = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const DAY_LONG = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Ringen uit het logo: buiten = vandaag, midden = deze week.
export function goalRings({ day, dayGoal, week, weekGoal, size = 132, cls = "" }) {
  const ring = (r, frac, kind) => {
    const L = 2 * Math.PI * r;
    const arc = L * 0.875; // zelfde opening als in het logo
    const val = Math.max(0, Math.min(1, frac)) * arc;
    return `<circle class="gr-track" cx="24" cy="24" r="${r}" stroke-dasharray="${arc.toFixed(2)} ${L.toFixed(2)}"/>
      <circle class="gr-val gr-${kind}" cx="24" cy="24" r="${r}" stroke-dasharray="${val.toFixed(2)} ${L.toFixed(2)}" ${val < 0.01 ? 'opacity="0"' : ""}/>`;
  };
  return `<svg class="goal-ring ${cls} ${pulsing() ? "pulse" : ""}" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">
    <g transform="rotate(-90 24 24)">${ring(20, day / dayGoal, "day")}${ring(13, week / weekGoal, "week")}${ring(6, 0, "core")}</g>
    <circle class="gr-dot" cx="24" cy="24" r="1.6"/></svg>`;
}

// Klein ringetje voor de rij in Bladeren.
export function miniRing(n, goal) {
  const r = 8.5, L = 2 * Math.PI * r, arc = L * 0.875, val = Math.min(1, n / goal) * arc;
  return `<svg class="mini-ring goal-ring ${pulsing() ? "pulse" : ""}" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <g transform="rotate(-90 12 12)"><circle class="gr-track" cx="12" cy="12" r="${r}" stroke-dasharray="${arc.toFixed(2)} ${L.toFixed(2)}"/>
    <circle class="gr-val gr-day" cx="12" cy="12" r="${r}" stroke-dasharray="${val.toFixed(2)} ${L.toFixed(2)}" ${val < 0.01 ? 'opacity="0"' : ""}/></g>
    <circle class="gr-dot" cx="12" cy="12" r="1.8"/></svg>`;
}

function weekChart() {
  const g = goals();
  const days = weekDays();
  const total = days.reduce((n, d) => n + d.count, 0);
  const max = Math.max(g.daily, ...days.map((d) => d.count), 1);
  const goalPct = (g.daily / max) * 100;
  const bars = days.map((d, i) => {
    const h = (d.count / max) * 100;
    const label = `${capitalize(DAY_LONG[i])} ${d.date.getDate()} ${MONTH_SHORT[d.date.getMonth()]}: ${d.future ? "nog niet" : plural(d.count, "taak", "taken") + " voltooid"}${d.off ? " (vrije dag)" : ""}`;
    return `<li class="bar ${d.isToday ? "is-today" : ""} ${d.future ? "is-future" : ""} ${d.off ? "is-off" : ""} ${d.count >= g.daily ? "is-met" : ""}" aria-label="${escapeHtml(label)}">
      <span class="bar-n" aria-hidden="true">${d.future || !d.count ? "" : d.count}</span>
      <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="height:${h.toFixed(1)}%"></span></span>
      <span class="bar-d" aria-hidden="true">${DAY_NAMES[i]}</span>
    </li>`;
  }).join("");
  return { total, html: `<div class="bars-wrap"><ol class="bars" aria-label="Voltooid per dag deze week">${bars}</ol>
    <span class="goal-line" style="--y:${goalPct.toFixed(1)}" aria-hidden="true"></span></div>` };
}

function weeksChart() {
  const g = goals();
  const weeks = lastWeeks(4);
  const max = Math.max(g.weekly, ...weeks.map((w) => w.count), 1);
  const bars = weeks.map((w) => {
    const label = `Week van ${w.start.getDate()} ${MONTH_SHORT[w.start.getMonth()]}: ${plural(w.count, "taak", "taken")} voltooid`;
    return `<li class="bar ${w.current ? "is-today" : ""} ${w.count >= g.weekly ? "is-met" : ""}" aria-label="${escapeHtml(label)}">
      <span class="bar-n" aria-hidden="true">${w.count || ""}</span>
      <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="height:${((w.count / max) * 100).toFixed(1)}%"></span></span>
      <span class="bar-d" aria-hidden="true">${w.current ? "deze" : w.start.getDate() + " " + MONTH_SHORT[w.start.getMonth()]}</span>
    </li>`;
  }).join("");
  return `<div class="bars-wrap weeks"><ol class="bars" aria-label="Voltooid per week, afgelopen 4 weken">${bars}</ol>
    <span class="goal-line" style="--y:${((g.weekly / max) * 100).toFixed(1)}" aria-hidden="true"></span></div>`;
}

function perProject() {
  const m = new Map();
  for (const r of weekRows()) { const k = r.project_id || ""; m.set(k, (m.get(k) || 0) + 1); }
  if (!m.size) return `<p class="list-empty">Nog niets voltooid deze week.</p>`;
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
    const p = k ? projectById(k) : null;
    const name = k ? (p ? p.name : "Verwijderd project") : "Inbox";
    return `<div class="list-row static" data-proj="${escapeHtml(k)}"><span class="lead-ic"><span class="dot-lg" style="--c:${p ? escapeHtml(p.color) : "var(--muted)"}"></span></span>
      <span class="grow">${escapeHtml(name)}</span><span class="count">${n}</span></div>`;
  }).join("");
}

function recent() {
  const list = completionRows().slice(0, 10);
  if (!list.length) return `<p class="list-empty">Nog niets voltooid.</p>`;
  return list.map((r) => {
    const exists = r.task_id && getTask(r.task_id);
    const inner = `<span class="lead-ic done-ic">${icon(r.recurring ? "repeat" : "check-circle", "icon-sm")}</span>
      <span class="grow">${escapeHtml(r.title)}</span><span class="hint">${escapeHtml(agoText(r.completed_at))}</span>`;
    return exists
      ? `<button type="button" class="list-row" data-act="open-done" data-id="${escapeHtml(r.task_id)}">${inner}</button>`
      : `<div class="list-row static muted">${inner}</div>`;
  }).join("");
}

function stepper(k, label, value, sub) {
  return `<div class="list-row static two-line stepper-row">
    <span class="grow"><span>${label}</span><small>${sub}</small></span>
    <span class="stepper" role="group" aria-label="${label}">
      <button type="button" class="icon-btn sm" data-act="goal-step" data-k="${k}" data-d="-1" aria-label="${label} lager" ${value <= 1 ? "disabled" : ""}>${icon("minus", "icon-sm")}</button>
      <output aria-live="polite" data-goal="${k}">${value}</output>
      <button type="button" class="icon-btn sm" data-act="goal-step" data-k="${k}" data-d="1" aria-label="${label} hoger">${icon("plus", "icon-sm")}</button>
    </span>
  </div>`;
}

export default {
  tab: "bladeren",
  topbar: () => ({ title: "Productiviteit", back: true, actions: [] }),
  hideFab: true,

  render() {
    if (!completionsLoaded()) {
      loadCompletions();
      return intro("Productiviteit") + `<div class="card skeleton" aria-hidden="true">${[60, 40, 70].map((w) => `<div class="sk-row"><span class="sk sk-c"></span><span class="sk" style="width:${w}%"></span></div>`).join("")}</div>`;
    }
    const g = goals();
    const n = todayCount();
    const st = streaks();
    const wk = weekChart();
    const range = getPref("stats-range", "week");
    const left = g.daily - n;
    const now = new Date();

    return `
      ${intro("Productiviteit", `${capitalize(WD_SHORT[now.getDay()])} ${now.getDate()} ${MONTH_SHORT[now.getMonth()]}`)}
      <section class="card stats-today">
        ${goalRings({ day: n, dayGoal: g.daily, week: wk.total, weekGoal: g.weekly, cls: "today-ring" })}
        <div class="stats-today-text">
          <p class="big" data-today="${n}"><b>${n}</b> van ${g.daily}</p>
          <p class="sub">${left > 0 ? `Nog ${left} voor je dagdoel` : "Dagdoel gehaald"}</p>
          <p class="legend"><span><i class="lg-day"></i>Vandaag</span><span><i class="lg-week"></i>Deze week</span></p>
        </div>
      </section>

      <section class="card stats-streak">
        <div><span class="stat-label">Reeks</span><span class="stat-val" data-streak="${st.current}">${plural(st.current, "dag", "dagen")}</span></div>
        <div><span class="stat-label">Langste reeks</span><span class="stat-val" data-longest="${st.longest}">${plural(st.longest, "dag", "dagen")}</span></div>
      </section>
      ${g.vacation ? `<p class="stats-note">${icon("sofa", "icon-xs")}Vakantiemodus staat aan</p>` : ""}

      <section class="group">
        <div class="group-head"><h2>${range === "weeks" ? "Afgelopen 4 weken" : "Deze week"}</h2><span class="grow"></span>
          <span class="count" data-week="${wk.total}">${range === "weeks" ? "" : `${wk.total} van ${g.weekly}`}</span></div>
        <div class="card stats-chart">
          ${range === "weeks" ? weeksChart() : wk.html}
          <div class="segmented two" role="group" aria-label="Periode">
            <button type="button" data-act="stats-range" data-v="week" aria-pressed="${range !== "weeks"}">Deze week</button>
            <button type="button" data-act="stats-range" data-v="weeks" aria-pressed="${range === "weeks"}">Afgelopen 4 weken</button>
          </div>
        </div>
      </section>

      <section class="group">
        <div class="group-head"><h2>Per project</h2><span class="count">deze week</span></div>
        <div class="card list-card" data-per-project>${perProject()}</div>
      </section>

      <section class="group">
        <div class="group-head"><h2>Recent voltooid</h2></div>
        <div class="card list-card" data-recent>${recent()}</div>
      </section>

      <section class="group">
        <div class="group-head"><h2>Doelen</h2></div>
        <div class="card list-card">
          ${stepper("daily_goal", "Dagdoel", g.daily, "Taken per dag")}
          ${stepper("weekly_goal", "Weekdoel", g.weekly, "Taken per week")}
        </div>
        <p class="sheet-label">Vrije dagen</p>
        <div class="day-chips" role="group" aria-label="Vrije dagen">
          ${DAY_NAMES.map((d, i) => `<button type="button" class="chip" data-act="day-off" data-d="${i + 1}" aria-pressed="${g.daysOff.includes(i + 1)}" aria-label="${DAY_LONG[i]}">${d}</button>`).join("")}
        </div>
        <p class="stats-help">Op vrije dagen loopt je reeks gewoon door.</p>
        <div class="card list-card">
          <label class="list-row static two-line" for="vacation-on">
            <span class="lead-ic">${icon("sofa")}</span>
            <span class="grow"><span>Vakantiemodus</span><small>Je reeks loopt niet af zolang dit aanstaat</small></span>
            <input type="checkbox" class="switch" id="vacation-on" ${g.vacation ? "checked" : ""}>
          </label>
        </div>
      </section>`;
  },

  onChange(e) {
    if (e.target.id === "vacation-on") saveSettings({ vacation_mode: e.target.checked });
  },

  async onClick(act, el) {
    if (act === "goal-step") {
      const k = el.dataset.k;
      const step = k === "weekly_goal" ? 5 : 1;
      const cur = settings()[k];
      let v = cur + step * Number(el.dataset.d);
      if (k === "weekly_goal" && Number(el.dataset.d) < 0 && cur % 5) v = cur - (cur % 5);
      v = Math.max(1, Math.min(k === "weekly_goal" ? 500 : 99, v));
      if (v !== cur) saveSettings({ [k]: v });
      return;
    }
    if (act === "day-off") {
      const d = Number(el.dataset.d);
      const cur = goals().daysOff;
      const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b);
      saveSettings({ days_off: next });
      return;
    }
    if (act === "stats-range") { setPref("stats-range", el.dataset.v); return "rerender"; }
    if (act === "open-done") { if (getTask(el.dataset.id)) actions.openTask(el.dataset.id); }
  },
};
