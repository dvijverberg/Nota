// Keuze-sheets: datum, prioriteit, labels, project/sectie, kleur.

import { parseDateText, describeRecurrence, formatDateLong, formatDue, todayStr, addDays, toDateStr, fromDateStr } from "./parse.js";
import { openSheet, escapeHtml, icon, capitalize } from "./ui.js";
import { state, activeProjects, sectionsOf, COLORS, createLabel, labelByName, dueMoment } from "./store.js";
import { PRIORITIES } from "./tasks.js";

const WD_SHORT = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function wdShort(str) { return WD_SHORT[fromDateStr(str).getDay()]; }

export function quickDates(now = new Date()) {
  const today = todayStr(now);
  const wd = now.getDay(); // 0 = zo
  // Volgend weekend: de eerstvolgende zaterdag; in het weekend zelf die van volgende week.
  const toSat = wd === 6 ? 7 : wd === 0 ? 6 : 6 - wd;
  // Volgende week: maandag van volgende week.
  const toMon = wd === 0 ? 1 : 8 - wd;
  return [
    { id: "today", label: "Vandaag", date: today, icon: "today", tone: "today" },
    { id: "tomorrow", label: "Morgen", date: addDays(today, 1), icon: "sun", tone: "tomorrow" },
    { id: "weekend", label: "Volgend weekend", date: addDays(today, toSat), icon: "sofa", tone: "week" },
    { id: "nextweek", label: "Volgende week", date: addDays(today, toMon), icon: "arrow-right", tone: "week" },
  ];
}

function hintFor(date) {
  const d = fromDateStr(date);
  const today = fromDateStr(todayStr());
  const diff = Math.round((d - today) / 864e5);
  return diff < 7 ? wdShort(date) : `${wdShort(date)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

// Datum (+ tijd + herhaling) kiezen. mode "deadline": alleen een datum.
// Resolves met {due_date, due_time, recurrence} of null bij annuleren.
export function dateSheet({ due_date = null, due_time = null, recurrence = null, mode = "due", title } = {}) {
  return new Promise((resolve) => {
    const draft = { due_date, due_time: due_time ? due_time.slice(0, 5) : null, recurrence };
    const deadline = mode === "deadline";
    let answered = false;
    const today = todayStr();
    let month = fromDateStr(draft.due_date || today);
    month = new Date(month.getFullYear(), month.getMonth(), 1);

    const sh = openSheet({
      label: title || (deadline ? "Deadline" : "Datum"),
      className: "tall-ish kb-aware",
      html: `
        <div class="sheet-scroll">
          <p class="sheet-title">${escapeHtml(title || (deadline ? "Deadline" : "Datum"))}</p>
          ${deadline ? "" : `
          <div class="date-text">
            ${icon("sparkle", "icon-sm")}
            <input class="input" type="text" placeholder="Typ een datum, bijv. elke ma om 9u" autocomplete="off" enterkeyhint="done" aria-label="Datum typen">
          </div>
          <p class="date-preview" aria-live="polite"></p>`}
          <div class="sheet-group" data-quick>
            ${quickDates().map((q) => `
              <button type="button" class="sheet-item" data-date="${q.date}">
                <span class="tone-${q.tone}">${icon(q.icon)}</span><span class="grow">${q.label}</span><span class="hint">${hintFor(q.date)}</span>
              </button>`).join("")}
            <button type="button" class="sheet-item" data-date="">
              <span class="tone-none">${icon("ban")}</span><span class="grow">Geen ${deadline ? "deadline" : "datum"}</span>
            </button>
          </div>
          <div class="cal" data-cal></div>
          ${deadline ? "" : `
          <div class="sheet-group form-rows">
            <label class="form-row">${icon("clock")}<span class="grow">Tijd</span>
              <input type="time" class="time-input" value="${draft.due_time || ""}" aria-label="Tijd">
              <button type="button" class="icon-btn sm clear-time" aria-label="Tijd wissen">${icon("x", "icon-sm")}</button>
            </label>
            <div class="form-row rec-row">${icon("repeat")}<span class="grow rec-text"></span>
              <button type="button" class="icon-btn sm clear-rec" aria-label="Herhaling wissen">${icon("x", "icon-sm")}</button>
            </div>
          </div>`}
          <div class="sheet-actions">
            <button type="button" class="btn-cancel" data-a="cancel">Annuleren</button>
            <button type="button" class="btn-ok" data-a="ok">Opslaan</button>
          </div>
        </div>`,
      onClose: () => { if (!answered) resolve(null); },
    });

    const finish = (val) => { answered = true; resolve(val); sh.close(); };

    function renderCal() {
      const y = month.getFullYear(), m = month.getMonth();
      const first = new Date(y, m, 1);
      const offset = (first.getDay() + 6) % 7; // maandag eerst
      const days = new Date(y, m + 1, 0).getDate();
      let cells = "";
      for (let i = 0; i < offset; i++) cells += `<span></span>`;
      for (let d = 1; d <= days; d++) {
        const ds = toDateStr(new Date(y, m, d));
        cells += `<button type="button" class="cal-day ${ds === today ? "is-today" : ""} ${ds === draft.due_date ? "is-sel" : ""} ${ds < today ? "is-past" : ""}" data-day="${ds}" aria-label="${formatDateLong(ds)}" aria-pressed="${ds === draft.due_date}">${d}</button>`;
      }
      sh.q("[data-cal]").innerHTML = `
        <div class="cal-head">
          <button type="button" class="icon-btn" data-m="-1" aria-label="Vorige maand">${icon("chevron-left")}</button>
          <span>${capitalize(MONTHS[m])} ${y !== new Date().getFullYear() ? y : ""}</span>
          <button type="button" class="icon-btn" data-m="1" aria-label="Volgende maand">${icon("chevron-right")}</button>
        </div>
        <div class="cal-grid cal-wd">${["ma", "di", "wo", "do", "vr", "za", "zo"].map((d) => `<span>${d}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>`;
    }

    function renderState() {
      renderCal();
      if (deadline) return;
      const rec = sh.q(".rec-row");
      rec.hidden = !draft.recurrence;
      if (draft.recurrence) sh.q(".rec-text").textContent = safeDescribe(draft.recurrence);
      sh.q(".time-input").value = draft.due_time || "";
      sh.q(".clear-time").hidden = !draft.due_time;
    }

    sh.el.addEventListener("click", (e) => {
      const q = e.target.closest("[data-quick] [data-date]");
      if (q) {
        if (!q.dataset.date) return finish({ due_date: null, due_time: null, recurrence: null });
        return finish({ ...draft, due_date: q.dataset.date });
      }
      const nav = e.target.closest("[data-m]");
      if (nav) { month = new Date(month.getFullYear(), month.getMonth() + Number(nav.dataset.m), 1); renderCal(); return; }
      const day = e.target.closest("[data-day]");
      if (day) {
        draft.due_date = day.dataset.day;
        if (deadline) return finish({ ...draft });
        renderState();
        return;
      }
      if (e.target.closest(".clear-time")) { e.preventDefault(); draft.due_time = null; renderState(); return; }
      if (e.target.closest(".clear-rec")) { draft.recurrence = null; renderState(); return; }
      const a = e.target.closest("[data-a]");
      if (a) {
        if (a.dataset.a === "cancel") { sh.close(); return; }
        if (!deadline) applyText();
        finish({ ...draft, due_date: draft.due_date || (draft.due_time ? today : null) });
      }
    });

    let parsed = null;
    function applyText() {
      if (!parsed) return;
      if (parsed.cleared) Object.assign(draft, { due_date: null, due_time: null, recurrence: null });
      else Object.assign(draft, { due_date: parsed.due_date, due_time: parsed.due_time || null, recurrence: parsed.recurrence || null });
    }
    if (!deadline) {
      const input = sh.q(".date-text input");
      const preview = sh.q(".date-preview");
      input.addEventListener("input", () => {
        const v = input.value.trim();
        parsed = v ? parseDateText(v, new Date()) : null;
        if (!v) { preview.textContent = ""; preview.className = "date-preview"; return; }
        if (!parsed) { preview.textContent = "Dat begrijp ik niet. Probeer bijv. “vrijdag 14u” of “elke maand op de 1e”."; preview.className = "date-preview bad"; return; }
        preview.className = "date-preview ok";
        preview.textContent = parsed.cleared ? "Geen datum" : [
          parsed.recurrence ? safeDescribe(parsed.recurrence) : null,
          parsed.due_date ? (parsed.recurrence ? "vanaf " + formatDateLong(parsed.due_date).toLowerCase() : formatDateLong(parsed.due_date)) : null,
          parsed.due_time ? "om " + parsed.due_time : null,
        ].filter(Boolean).join(", ");
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!parsed) return;
          applyText();
          finish({ ...draft });
        }
      });
      sh.q(".time-input").addEventListener("input", (e) => { draft.due_time = e.target.value || null; sh.q(".clear-time").hidden = !draft.due_time; });
    }
    renderState();
  });
}

export function safeDescribe(rec) {
  try { return describeRecurrence(rec); } catch { return rec && rec.text ? capitalize(rec.text) : "Herhalend"; }
}

// ---------- Prioriteit ----------
export function prioritySheet(current = 4) {
  return new Promise((resolve) => {
    let answered = false;
    const sh = openSheet({
      label: "Prioriteit",
      html: `
        <p class="sheet-title">Prioriteit</p>
        <div class="sheet-group">
          ${PRIORITIES.map((p) => `
            <button type="button" class="sheet-item" data-p="${p.p}" aria-pressed="${p.p === current}">
              <span style="color:${p.color}">${icon(p.p === 4 ? "flag" : "flag-fill")}</span><span class="grow">${p.name}</span>
              ${p.p === current ? icon("check", "icon-sm tick") : ""}
            </button>`).join("")}
        </div>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    sh.el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-p]");
      if (!b) return;
      answered = true; resolve(Number(b.dataset.p)); sh.close();
    });
  });
}

// ---------- Labels (meerdere kiezen + nieuwe maken) ----------
export function labelsSheet(selected = []) {
  return new Promise((resolve) => {
    const sel = new Set(selected);
    let answered = false;
    const sh = openSheet({
      label: "Labels",
      className: "tall-ish kb-aware",
      html: `
        <p class="sheet-title">Labels</p>
        <input class="input" type="text" placeholder="Zoek of maak een label" autocomplete="off" enterkeyhint="done" aria-label="Label zoeken of maken">
        <div class="sheet-scroll label-scroll"><div class="sheet-group" data-list></div></div>
        <div class="sheet-actions one">
          <button type="button" class="btn-ok" data-a="ok">Klaar</button>
        </div>`,
      onClose: () => { if (!answered) resolve([...sel]); },
    });
    const input = sh.q("input");
    function render() {
      const q = input.value.trim();
      const names = [...new Set([...state.labels.map((l) => l.name), ...sel])];
      const list = names.filter((n) => !q || n.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, "nl"));
      const exact = names.some((n) => n.toLowerCase() === q.toLowerCase());
      sh.q("[data-list]").innerHTML =
        list.map((n) => {
          const l = labelByName(n);
          return `
          <button type="button" class="sheet-item" data-l="${escapeHtml(n)}" aria-pressed="${sel.has(n)}">
            <span style="color:${escapeHtml(l?.color || "var(--muted)")}">${icon("tag")}</span><span class="grow">${escapeHtml(n)}</span>
            <span class="box ${sel.has(n) ? "on" : ""}">${icon("check", "icon-xs")}</span>
          </button>`;
        }).join("") +
        (q && !exact ? `<button type="button" class="sheet-item" data-new="${escapeHtml(q)}">${icon("plus")}<span class="grow">Label “${escapeHtml(q)}” maken</span></button>` : "") +
        (!list.length && !q ? `<p class="sheet-empty">Nog geen labels. Typ een naam om er een te maken.</p>` : "");
    }
    sh.el.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-l]");
      if (b) { const n = b.dataset.l; if (sel.has(n)) sel.delete(n); else sel.add(n); render(); return; }
      const nb = e.target.closest("[data-new]");
      if (nb) {
        const name = nb.dataset.new.replace(/^@/, "");
        sel.add(name); input.value = ""; render();
        await createLabel(name);
        render();
        return;
      }
      if (e.target.closest('[data-a="ok"]')) { answered = true; resolve([...sel]); sh.close(); }
    });
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const nb = sh.q("[data-new]"); if (nb) nb.click(); }
    });
    render();
  });
}

// ---------- Project + sectie ----------
export function projectSheet({ project_id = null, section_id = null, sections = true, title = "Project" } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const projects = activeProjects();
    const row = (pid, sid, name, color, depth) => {
      const on = (pid || null) === (project_id || null) && (sid || null) === (section_id || null);
      return `
        <button type="button" class="sheet-item ${depth ? "sub" : ""}" data-p="${pid || ""}" data-s="${sid || ""}" aria-pressed="${on}">
          ${depth ? `<span class="sec-mark">${icon("section", "icon-sm")}</span>` : pid ? `<span class="dot-lg" style="--c:${escapeHtml(color)}"></span>` : `<span style="color:var(--accent)">${icon("inbox")}</span>`}
          <span class="grow">${escapeHtml(name)}</span>${on ? icon("check", "icon-sm tick") : ""}
        </button>`;
    };
    const sh = openSheet({
      label: title,
      className: "tall-ish",
      html: `
        <p class="sheet-title">${escapeHtml(title)}</p>
        <div class="sheet-scroll"><div class="sheet-group">
          ${row(null, null, "Inbox", null, 0)}
          ${projects.map((p) => row(p.id, null, p.name, p.color, 0) +
            (sections ? sectionsOf(p.id).map((s) => row(p.id, s.id, s.name, p.color, 1)).join("") : "")).join("")}
        </div></div>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    sh.el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-p]");
      if (!b) return;
      answered = true;
      resolve({ project_id: b.dataset.p || null, section_id: b.dataset.s || null });
      sh.close();
    });
  });
}

// ---------- Project/label/filter bewerken (naam + kleur [+ favoriet / query]) ----------
export function editSheet({ title, name = "", color = COLORS[11].hex, favorite = null, query = null, validate = null, ok = "Opslaan", presets = null }) {
  return new Promise((resolve) => {
    let answered = false;
    let cur = color;
    const sh = openSheet({
      label: title,
      className: "tall-ish kb-aware",
      html: `
        <div class="sheet-scroll">
        <p class="sheet-title">${escapeHtml(title)}</p>
        <form class="edit-form">
          <label class="field-sm"><span>Naam</span>
            <input class="input" name="name" type="text" value="${escapeHtml(name)}" autocomplete="off" required enterkeyhint="next">
          </label>
          ${query !== null ? `
          <label class="field-sm"><span>Filter</span>
            <input class="input mono" name="query" type="text" value="${escapeHtml(query)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bijv. vandaag | achterstallig" enterkeyhint="done">
          </label>
          <p class="filter-check" aria-live="polite"></p>
          ${presets ? `<div class="chips presets">${presets.map((p) => `<button type="button" class="chip" data-preset="${escapeHtml(p.query)}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`).join("")}</div>` : ""}
          <p class="filter-help">Combineer met <b>&amp;</b> (en), <b>|</b> (of) en <b>!</b> (niet). Bijv. <code>p1 &amp; 7 dagen</code>, <code>#Werk &amp; !@wachten</code>, <code>geen datum</code>.</p>` : ""}
          <p class="sheet-label">Kleur</p>
          <div class="colors" role="radiogroup" aria-label="Kleur">
            ${COLORS.map((c) => `<button type="button" class="swatch" role="radio" data-c="${c.hex}" style="--c:${c.hex}" aria-checked="${c.hex.toLowerCase() === String(cur).toLowerCase()}" aria-label="${c.name}"></button>`).join("")}
          </div>
          ${favorite !== null ? `
          <label class="form-row toggle-row">${icon("star")}<span class="grow">Favoriet</span>
            <input type="checkbox" name="favorite" class="switch" ${favorite ? "checked" : ""}>
          </label>` : ""}
          <div class="sheet-actions">
            <button type="button" class="btn-cancel" data-a="cancel">Annuleren</button>
            <button type="submit" class="btn-ok">${escapeHtml(ok)}</button>
          </div>
        </form>
        </div>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    const form = sh.q("form");
    const nameIn = form.elements.name;
    const qIn = form.elements.query;
    const check = sh.q(".filter-check");
    const runCheck = () => {
      if (!qIn || !validate) return true;
      const v = qIn.value.trim();
      if (!v) { check.textContent = ""; check.className = "filter-check"; return false; }
      const r = validate(v);
      check.className = "filter-check " + (r.ok ? "ok" : "bad");
      check.textContent = r.ok ? `Klopt. ${r.count != null ? `${r.count} ${r.count === 1 ? "taak" : "taken"} nu.` : ""}` : r.error;
      return r.ok;
    };
    if (qIn) { qIn.addEventListener("input", runCheck); runCheck(); }
    if (!name) nameIn.focus({ preventScroll: true });
    sh.el.addEventListener("click", (e) => {
      const sw = e.target.closest(".swatch");
      if (sw) {
        cur = sw.dataset.c;
        sh.qa(".swatch").forEach((x) => x.setAttribute("aria-checked", String(x === sw)));
        return;
      }
      const pr = e.target.closest("[data-preset]");
      if (pr) {
        qIn.value = pr.dataset.preset;
        if (!nameIn.value.trim()) nameIn.value = pr.dataset.name;
        runCheck();
        return;
      }
      if (e.target.closest('[data-a="cancel"]')) sh.close();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const n = nameIn.value.trim();
      if (!n) { nameIn.focus(); return; }
      if (qIn && !runCheck()) { qIn.focus(); return; }
      answered = true;
      resolve({ name: n, color: cur, favorite: form.elements.favorite ? form.elements.favorite.checked : undefined, query: qIn ? qIn.value.trim() : undefined });
      sh.close();
    });
  });
}

// ---------- Herinnering ----------
// Zonder reminder_at volgt de server de starttijd (als de taak een tijd
// heeft). reminder_at is altijd een absoluut moment; "x min van tevoren"
// rekenen we om vanaf de datum + tijd van de taak.
const OFFSETS = [
  { min: 10, label: "10 min van tevoren" },
  { min: 30, label: "30 min van tevoren" },
  { min: 60, label: "1 uur van tevoren" },
];
const MORNING = "08:00";
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function reminderChoice(t) {
  if (!t.reminder_at) return t.due_time ? "at" : "none";
  const r = new Date(t.reminder_at);
  if (isNaN(r)) return "custom";
  if (t.due_date && t.due_time) {
    const diff = Math.round((dueMoment(t.due_date, t.due_time.slice(0, 5)) - r) / 60000);
    if (diff === 0) return "at";
    const o = OFFSETS.find((x) => x.min === diff);
    if (o) return "m" + o.min;
  }
  if (t.due_date && toDateStr(r) === t.due_date && hm(r) === MORNING) return "morning";
  return "custom";
}

// { text, empty, past } voor de rij in de taakdetails.
export function describeReminder(t, now = new Date()) {
  const time = t.due_time ? t.due_time.slice(0, 5) : null;
  if (!t.reminder_at) {
    if (t.due_date && time) return { text: `Bij de starttijd (${time})`, empty: false, past: false };
    return { text: "Geen", empty: true, past: false };
  }
  const r = new Date(t.reminder_at);
  if (isNaN(r)) return { text: "Geen", empty: true, past: false };
  const c = reminderChoice(t);
  const o = OFFSETS.find((x) => "m" + x.min === c);
  const text = o ? `${o.label} (${hm(r)})`
    : c === "at" ? `Bij de starttijd (${hm(r)})`
    : formatDue(toDateStr(r), hm(r), now).text;
  return { text, empty: false, past: r < now };
}

// Resolves met { reminder_at } of null bij annuleren.
export function reminderSheet(t) {
  return new Promise((resolve) => {
    let answered = false;
    const time = t.due_time ? t.due_time.slice(0, 5) : null;
    const base = t.due_date && time ? dueMoment(t.due_date, time) : null;
    const cur = reminderChoice(t);
    const opts = [];
    if (base) {
      opts.push({ id: "at", label: "Op het moment zelf", hint: time, value: null });
      for (const o of OFFSETS) opts.push({ id: "m" + o.min, label: o.label, hint: hm(new Date(base - o.min * 60000)), value: new Date(base - o.min * 60000).toISOString() });
    }
    if (t.due_date) opts.push({ id: "morning", label: "Ochtend van de dag zelf", hint: MORNING, value: dueMoment(t.due_date, MORNING).toISOString() });
    if (!base) opts.push({ id: "none", label: "Geen herinnering", value: null, icon: "ban" });

    const r0 = t.reminder_at ? new Date(t.reminder_at) : null;
    const draft = {
      date: r0 && !isNaN(r0) ? toDateStr(r0) : t.due_date || todayStr(),
      time: r0 && !isNaN(r0) ? hm(r0) : time || "09:00",
    };

    const sh = openSheet({
      label: "Herinnering",
      className: "tall-ish",
      html: `
        <div class="sheet-scroll">
          <p class="sheet-title">Herinnering</p>
          <p class="sheet-sub">${base ? "Taken met een tijd geven altijd een melding, standaard op de starttijd." : t.due_date ? "Deze taak heeft geen tijd. Kies wanneer je een melding wilt." : "Deze taak heeft geen datum. Kies een moment voor de melding."}</p>
          <div class="sheet-group" data-opts>
            ${opts.map((o) => `
              <button type="button" class="sheet-item" data-r="${o.id}" aria-pressed="${o.id === cur}">
                ${icon(o.icon || (o.id === "morning" ? "sun" : o.id === "at" ? "bell" : "clock"))}
                <span class="grow">${o.label}</span>
                ${o.hint ? `<span class="hint">${o.hint}</span>` : ""}
                ${o.id === cur ? icon("check", "icon-sm tick") : ""}
              </button>`).join("")}
            <button type="button" class="sheet-item" data-r="custom" aria-pressed="${cur === "custom"}" aria-expanded="false">
              ${icon("calendar")}<span class="grow">Ander moment…</span>
              ${cur === "custom" ? icon("check", "icon-sm tick") : ""}
            </button>
          </div>
          <div class="rem-custom" hidden>
            <div class="sheet-group form-rows">
              <label class="form-row">${icon("calendar")}<span class="grow">Datum</span>
                <input type="date" class="time-input" data-f="date" value="${draft.date}" aria-label="Datum"></label>
              <label class="form-row">${icon("clock")}<span class="grow">Tijd</span>
                <input type="time" class="time-input" data-f="time" value="${draft.time}" aria-label="Tijd"></label>
            </div>
            <p class="date-preview rem-preview" aria-live="polite"></p>
            <div class="sheet-actions">
              <button type="button" class="btn-cancel" data-a="cancel">Annuleren</button>
              <button type="button" class="btn-ok" data-a="ok">Opslaan</button>
            </div>
          </div>
        </div>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    const finish = (val) => { answered = true; resolve(val); sh.close(); };
    const custom = sh.q(".rem-custom");

    function preview() {
      const p = sh.q(".rem-preview");
      const ok = sh.q('[data-a="ok"]');
      if (!draft.date || !draft.time) { p.textContent = "Kies een datum en tijd."; p.className = "date-preview rem-preview"; ok.disabled = true; return; }
      const at = dueMoment(draft.date, draft.time);
      const past = at < new Date();
      p.textContent = past ? "Dit moment is al voorbij." : `${formatDateLong(draft.date)} om ${draft.time}`;
      p.className = "date-preview rem-preview " + (past ? "bad" : "ok");
      ok.disabled = past;
    }

    sh.el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]");
      if (b) {
        if (b.dataset.r === "custom") {
          custom.hidden = !custom.hidden;
          b.setAttribute("aria-expanded", String(!custom.hidden));
          if (!custom.hidden) { preview(); custom.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
          return;
        }
        const o = opts.find((x) => x.id === b.dataset.r);
        if (o) finish({ reminder_at: o.value });
        return;
      }
      const a = e.target.closest("[data-a]");
      if (!a) return;
      if (a.dataset.a === "cancel") { sh.close(); return; }
      if (!draft.date || !draft.time || dueMoment(draft.date, draft.time) < new Date()) return;
      finish({ reminder_at: dueMoment(draft.date, draft.time).toISOString() });
    });
    custom.addEventListener("input", (e) => {
      const f = e.target.dataset.f;
      if (f) { draft[f] = e.target.value || ""; preview(); }
    });
  });
}
