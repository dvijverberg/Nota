// parse.js — Nota: "snel toevoegen" parser, recurrence, date formatting and filters.
// Plain ES module, no imports, no dependencies. Works in browsers and Node 18+.
//
// Conventions
// - Dates are LOCAL calendar dates as 'YYYY-MM-DD' strings, times 'HH:MM' (24h).
//   We never use toISOString (UTC shift bugs); strings are built from local fields.
// - Week starts on Monday; weekday numbers are ISO: 1 = maandag .. 7 = zondag.
// - Every function takes an optional `now` (Date) so tests are deterministic.
//
// Documented choices (where the spec left room):
// - A weekday name on the same weekday as today means TODAY ("donderdag" on a Thursday).
// - "volgende <weekdag>" = that weekday in NEXT week (Mon-Sun), strictly after this week.
// - "om N" without "u"/":"/"uur" and N < 7 is ambiguous ("Bel om 3 klanten") and is NOT a time.
//   "om 3u", "om 3:00", "om 3 uur" are explicit and do parse as 03:00.
// - A bare "9" is never a time; "9u", "9:30", "9am", "om 9" are.
// - "14.30" is only a time after "om"/"at"/"rond".
// - Time without date: today if the time is still ahead, otherwise tomorrow.
// - Recurrence without explicit date: first occurrence ON/AFTER today, ignoring the time of day.
//   E.g. Thursday 10:00, "elke ma en do om 7:30" -> due today (Thursday) 07:30.
// - Only the first date / time / recurrence / project / section / priority phrase is used;
//   later duplicates stay in the title (safer than eating words). Labels: all are used.
// - Monthly recurrences always get a `monthday` (from the first due date) to avoid drift;
//   monthday >= 31 means "last day of the month".
// - Dangling prepositions ("voor", "tegen", ...) are stripped only when they directly precede a
//   removed date/time/recurrence token that ends the title. "op"/"on"/"vanaf" directly before a
//   weekday or date are always part of the date token.

/* ------------------------------------------------------------------ */
/* Date helpers                                                         */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' using local fields. */
export function toDateStr(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date at local midnight. */
export function fromDateStr(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Add n calendar days to a date string. */
export function addDays(str, n) {
  const d = fromDateStr(str);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Today's date string. */
export function todayStr(now = new Date()) {
  return toDateStr(now);
}

const isoWd = (str) => { const d = fromDateStr(str).getDay(); return d === 0 ? 7 : d; };
const dim = (y, m) => new Date(y, m, 0).getDate(); // days in month (m = 1..12)
const diffDays = (a, b) => Math.round((fromDateStr(b) - fromDateStr(a)) / 86400000); // b - a
const nowHM = (now) => `${pad(now.getHours())}:${pad(now.getMinutes())}`;
const ymd = (str) => str.split('-').map(Number);

function makeDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= dim(y, m))) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
function addMonthsClamped(y, m, day, n) {
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return makeDate(ny, nm, Math.min(day, dim(ny, nm)));
}
const mondayOf = (str) => addDays(str, 1 - isoWd(str));

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

const WD_NL = ['', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const MONTH_NL = ['', 'januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus',
  'september', 'oktober', 'november', 'december'];
const MONTH_NL_SHORT = ['', 'jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

const WD_FULL = {
  maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};
const WD_ABBR = {
  ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6, zo: 7,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};
const WD_ALL = { ...WD_FULL, ...WD_ABBR };
const MONTHS = {
  januari: 1, january: 1, jan: 1, februari: 2, february: 2, feb: 2, maart: 3, march: 3, mrt: 3, mar: 3,
  april: 4, apr: 4, mei: 5, may: 5, juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7,
  augustus: 8, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const NUMWORDS = {
  een: 1, 'één': 1, a: 1, an: 1, one: 1, twee: 2, two: 2, drie: 3, three: 3, vier: 4, four: 4,
  vijf: 5, five: 5, zes: 6, six: 6, zeven: 7, seven: 7, acht: 8, eight: 8, negen: 9, nine: 9,
  tien: 10, ten: 10, elf: 11, twaalf: 12,
};
const DAYPART = { ochtend: '09:00', middag: '13:00', avond: '19:00' };

const alt = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length).join('|');
const toNum = (s) => (s == null ? null : /^\d+$/.test(s) ? parseInt(s, 10) : NUMWORDS[s.toLowerCase()] ?? null);

// Regex building blocks. {B}/{E}: word boundaries that also reject '-', '/', '@', '#', apostrophes,
// so "maandag-overleg", "#maandag", "zo'n" never match.
const PARTS = {
  B: "(?<![\\p{L}\\p{N}_\\-/@#'’])(?<!\\p{N}[:.,])",   // also not right after "9:" / "2."
  E: "(?![\\p{L}\\p{N}_\\-/'’])(?![:.,]\\p{N})",
  EVERY: '(?:elke|elk|iedere|ieder|every|each)',
  NUM: '(?:\\d{1,3}|' + alt(NUMWORDS) + ')',
  WDF: '(?:' + alt(WD_FULL) + ')',
  WDA: '(?:' + alt(WD_ABBR) + ')',
  WD: '(?:' + alt(WD_ALL) + ')',
  MON: '(?:' + alt(MONTHS) + ')',
  PFX: '(?:(?:op|on|vanaf)\\s+)?',
};
PARTS.WDLIST = `${PARTS.WD}\\.?(?:\\s*(?:,|en|and|&|\\+)\\s*${PARTS.WD}\\.?)*`;
const R = (src) => src.replace(/\{([A-Z]+)\}/g, (_, k) => PARTS[k]); // only {UPPER} placeholders, not {2}
const daysFrom = (txt) => {
  const out = new Set();
  const re = new RegExp(PARTS.B + '(' + alt(WD_ALL) + ')' + PARTS.E, 'giu');
  let m; while ((m = re.exec(txt))) out.add(WD_ALL[m[1].toLowerCase()]);
  return [...out].sort((a, b) => a - b);
};

/* ------------------------------------------------------------------ */
/* Pattern tables                                                       */
/* ------------------------------------------------------------------ */
// Each pattern: { re: source, tier?: number, fn(match, today, now) -> value | null }

// Date patterns -> { date, time? }
function weekdayNext(today, wd) { return addDays(today, (wd - isoWd(today) + 7) % 7); }
function weekdayNextWeek(today, wd) { return addDays(mondayOf(today), 7 + wd - 1); }
function dayMonth(today, d, mo, yearTxt) {
  const [ty] = ymd(today);
  if (yearTxt) {
    let y = parseInt(yearTxt, 10); if (y < 100) y += 2000;
    return makeDate(y, mo, d);
  }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  // No year: this year, or next year if already passed (29 feb -> next leap year).
  for (let y = ty; y < ty + 9; y++) { const s = makeDate(y, mo, d); if (s && s >= today) return s; }
  return null;
}

const DATE_PATTERNS = [
  { re: R('{B}{PFX}(\\d{4})-(\\d{1,2})-(\\d{1,2}){E}'), fn: (m) => makeDate(+m[1], +m[2], +m[3]) },
  { re: R('{B}{PFX}(\\d{1,2})([-/])(\\d{1,2})\\2(\\d{4}|\\d{2}){E}'), fn: (m, t) => dayMonth(t, +m[1], +m[3], m[4]) },
  { re: R('{B}{PFX}(\\d{1,2})([-/])(\\d{1,2}){E}'), tier: 2, fn: (m, t) => dayMonth(t, +m[1], +m[3]) },
  {
    re: R('{B}{PFX}(\\d{1,2})(?:e|de|ste|st|nd|rd|th)?\\s*({MON})\\.?(?:\\s+(\\d{4}))?{E}'),
    fn: (m, t) => (m[2] === 'Jan' ? null /* "3 Jan" is probably a person */ : dayMonth(t, +m[1], MONTHS[m[2].toLowerCase()], m[3])),
  },
  {
    re: R('{B}(overmorgen|morgen|vandaag)(?:\\s*(ochtend|middag|avond))?{E}'),
    fn: (m, t) => {
      const w = m[1].toLowerCase();
      const date = w === 'vandaag' ? t : addDays(t, w === 'morgen' ? 1 : 2);
      return { date, time: m[2] ? DAYPART[m[2].toLowerCase()] : null };
    },
  },
  {
    re: R('{B}(today|tomorrow|tonight|vanavond|vanochtend|vanmorgen|vanmiddag){E}'),
    fn: (m, t) => {
      const w = m[1].toLowerCase();
      const times = { tonight: '19:00', vanavond: '19:00', vanochtend: '09:00', vanmorgen: '09:00', vanmiddag: '13:00' };
      return { date: w === 'tomorrow' ? addDays(t, 1) : t, time: times[w] || null };
    },
  },
  {
    re: R('{B}{PFX}(?:(volgende|next|komende|aanstaande)\\s+)?({WDF})(?:\\s*(ochtend|middag|avond))?{E}'),
    fn: (m, t) => {
      const wd = WD_FULL[m[2].toLowerCase()];
      const nxt = m[1] && /^(volgende|next)$/i.test(m[1]);
      return { date: nxt ? weekdayNextWeek(t, wd) : weekdayNext(t, wd), time: m[3] ? DAYPART[m[3].toLowerCase()] : null };
    },
  },
  {
    // 2-letter / 3-letter abbreviations only after "op"/"on".
    re: R('{B}(?:op|on)\\s+(?:(volgende|next)\\s+)?({WDA})\\.?{E}'),
    fn: (m, t) => { const wd = WD_ABBR[m[2].toLowerCase()]; return m[1] ? weekdayNextWeek(t, wd) : weekdayNext(t, wd); },
  },
  { re: R('{B}(?:volgende|next|komende)\\s+week{E}'), fn: (m, t) => addDays(mondayOf(t), 7) },
  { re: R('{B}(?:volgende|next|komende)\\s+(?:maand|month){E}'), fn: (m, t) => { const [y, mo] = ymd(t); return addMonthsClamped(y, mo, 1, 1); } },
  { re: R('{B}(?:volgend|next|komend)\\s+(?:jaar|year){E}'), fn: (m, t) => `${ymd(t)[0] + 1}-01-01` },
  {
    re: R('{B}(?:(dit|this|volgend|next|komend)\\s+)?weekend{E}'),
    fn: (m, t) => {
      const w = isoWd(t);
      if (m[1] && /^(volgend|next)$/i.test(m[1])) return addDays(mondayOf(t), 12);
      return w === 7 ? t : addDays(t, 6 - w);
    },
  },
  {
    re: R('{B}(?:(?:aan\\s+het\\s+)?eind(?:e)?\\s+(?:van\\s+)?(?:de\\s+|deze\\s+)?(week|maand)|end\\s+of\\s+(?:the\\s+)?(week|month)){E}'),
    fn: (m, t) => {
      const unit = (m[1] || m[2]).toLowerCase();
      if (unit === 'week') { const w = isoWd(t); return w <= 5 ? addDays(t, 5 - w) : addDays(t, 12 - w); }
      const [y, mo] = ymd(t); return makeDate(y, mo, dim(y, mo));
    },
  },
  {
    re: R('{B}(?:over|in)\\s+({NUM})\\s+(dagen|dag|days|day|weken|week|weeks|maanden|maand|months|month|jaren|jaar|years|year){E}'),
    fn: (m, t) => {
      const n = toNum(m[1]); if (n == null) return null;
      const u = m[2].toLowerCase();
      if (u.startsWith('d')) return addDays(t, n);
      if (u.startsWith('w')) return addDays(t, 7 * n);
      const [y, mo, d] = ymd(t);
      if (u.startsWith('m')) return addMonthsClamped(y, mo, d, n);
      return addMonthsClamped(y, mo, d, 12 * n);
    },
  },
];

// Time patterns -> 'HH:MM'
const TIME_PATTERNS = [
  {
    re: R('{B}(?:(om|at|rond)\\s+)?(\\d{1,2})(?:([:.])(\\d{2}))?(?:\\s*(uur|u|h|am|pm)(\\d{2})?)?{E}'),
    fn: (m) => {
      const pre = m[1], sep = m[3], suf = m[5] && m[5].toLowerCase();
      let h = +m[2], mi = m[4] != null ? +m[4] : m[6] != null ? +m[6] : 0;
      if (m[6] != null && (sep || suf === 'am' || suf === 'pm')) return null; // "9:30u15" nonsense
      if (sep === '.' && !pre) return null;            // "1.5" / "versie 2.10"
      if (!pre && !sep && !suf) return null;           // bare number is never a time
      if (pre && !sep && !suf && h < 7) return null;   // "om 3" ambiguous ("Bel om 3 klanten")
      if (suf === 'am' || suf === 'pm') {
        if (h < 1 || h > 12) return null;
        h = (h % 12) + (suf === 'pm' ? 12 : 0);
      }
      if (h > 23 || mi > 59) return null;
      return `${pad(h)}:${pad(mi)}`;
    },
  },
];

// Recurrence patterns -> { freq, interval, days?, workdays?, monthday? }
const RECUR_PATTERNS = [
  { re: R('{B}{EVERY}\\s+({WDLIST}){E}'), fn: (m) => ({ freq: 'week', interval: 1, days: daysFrom(m[1]) }) },
  {
    re: R('{B}(?:{EVERY}\\s+(?:({NUM})\\s+|(andere|other)\\s+)?(?:weken|weeks|week)|(tweewekelijks|wekelijks|weekly|biweekly)|(om)\\s+de\\s+(?:({NUM})\\s+)?(?:weken|week))(?:\\s+(?:op|on)\\s+({WDLIST}))?{E}'),
    fn: (m) => {
      let interval = 1;
      if (m[1]) interval = toNum(m[1]);
      else if (m[2]) interval = 2;
      else if (m[3]) interval = /^(twee|bi)/i.test(m[3]) ? 2 : 1;
      else if (m[4]) interval = m[5] ? toNum(m[5]) : 2; // "om de week" = every other week
      if (!interval) return null;
      const r = { freq: 'week', interval };
      if (m[6]) r.days = daysFrom(m[6]);
      return r;
    },
  },
  {
    re: R('{B}(?:{EVERY}\\s+(?:werkdag|doordeweekse\\s+dag|weekday|workday)|(?:op|alle)\\s+werkdagen|on\\s+weekdays){E}'),
    fn: () => ({ freq: 'week', interval: 1, days: [1, 2, 3, 4, 5], workdays: true }),
  },
  {
    re: R('{B}(?:{EVERY}\\s+(?:({NUM})\\s+)?(?:maanden|maand|months|month)|maandelijks|monthly)\\s+(?:op\\s+de|on\\s+the)\\s+(\\d{1,2})(?:e|de|ste|st|nd|rd|th)?{E}'),
    fn: (m) => { const n = m[1] ? toNum(m[1]) : 1; const d = +m[2]; return n && d >= 1 && d <= 31 ? { freq: 'month', interval: n, monthday: d } : null; },
  },
  {
    re: R('{B}{EVERY}\\s+(\\d{1,2})(?:e|de|ste|st|nd|rd|th)(?:\\s+(?:van\\s+de\\s+maand|of\\s+the\\s+month))?{E}'),
    fn: (m) => { const d = +m[1]; return d >= 1 && d <= 31 ? { freq: 'month', interval: 1, monthday: d } : null; },
  },
  {
    re: R('{B}(?:{EVERY}\\s+(?:laatste\\s+dag\\s+van\\s+de\\s+maand|last\\s+day\\s+of\\s+the\\s+month)|{EVERY}\\s+maand\\s+op\\s+de\\s+laatste\\s+dag){E}'),
    fn: () => ({ freq: 'month', interval: 1, monthday: 31 }),
  },
  {
    re: R('{B}(?:{EVERY}\\s+(?:({NUM})\\s+|(andere|other)\\s+)?(dagen|dag|days|day|maanden|maand|months|month|jaren|jaar|years|year)|om\\s+de\\s+(?:({NUM})\\s+)?(dagen|dag|maanden|maand|jaren|jaar)){E}'),
    fn: (m) => {
      const unit = (m[3] || m[5]).toLowerCase();
      const freq = unit.startsWith('d') ? 'day' : unit.startsWith('m') ? 'month' : 'year';
      let interval;
      if (m[3]) interval = m[1] ? toNum(m[1]) : m[2] ? 2 : 1;
      else interval = m[4] ? toNum(m[4]) : 2;
      return interval ? { freq, interval } : null;
    },
  },
  {
    re: R('{B}(dagelijks|daily|maandelijks|monthly|jaarlijks|yearly|annually){E}'),
    fn: (m) => { const w = m[1].toLowerCase(); return { freq: /^(dag|dai)/.test(w) ? 'day' : /^(maa|mon)/.test(w) ? 'month' : 'year', interval: 1 }; },
  },
];
for (const list of [DATE_PATTERNS, TIME_PATTERNS, RECUR_PATTERNS]) for (const p of list) p.rx = new RegExp(p.re, 'giu');

/* ------------------------------------------------------------------ */
/* Scanning machinery                                                   */
/* ------------------------------------------------------------------ */

const overlaps = (claimed, s, e) => claimed.some((c) => s < c.end && e > c.start);

/** All non-overlapping-with-claimed candidates of a pattern table; returns the best one or null.
 *  Best = lowest tier, then earliest start, then longest. */
function bestMatch(input, claimed, patterns, today, now) {
  let best = null;
  for (const p of patterns) {
    const re = p.rx; re.lastIndex = 0;
    let m;
    while ((m = re.exec(input))) {
      const s = m.index, e = s + m[0].length;
      re.lastIndex = s + 1;
      if (overlaps(claimed, s, e)) continue;
      const val = p.fn(m, today, now);
      if (val == null) continue;
      const c = { start: s, end: e, val, tier: p.tier || 1 };
      if (!best || c.tier < best.tier || (c.tier === best.tier && (c.start < best.start || (c.start === best.start && e - s > best.end - best.start)))) best = c;
    }
  }
  return best;
}

/** Longest date-pattern match starting exactly at `pos` (for "deadline vrijdag"). */
function dateAt(input, pos, claimed, today, now) {
  let best = null;
  for (const p of DATE_PATTERNS) {
    const re = new RegExp(p.re, 'yiu'); re.lastIndex = pos;
    const m = re.exec(input);
    if (!m) continue;
    const e = pos + m[0].length;
    if (overlaps(claimed, pos, e)) continue;
    const val = p.fn(m, today, now);
    if (val == null) continue;
    if (!best || e > best.end) best = { start: pos, end: e, val };
  }
  return best;
}

const TRAIL_PUNCT = /[.,;:!?)\]]+$/;
const norm = (s) => s.toLowerCase().replace(/_/g, ' ');
const nameEnds = (rest, k) => k === rest.length || /[\s,.;:!?)\]]/.test(rest[k]);

/** "#Project" / "@label" with longest existing multi-word match, else a single word. */
function sigilName(rest, known) {
  const sorted = [...known].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (norm(rest.slice(0, k.length)) === norm(k) && nameEnds(rest, k.length)) return { len: k.length, exact: k };
  }
  const w = ((rest.match(/^[^\s#@]+/) || [''])[0]).replace(TRAIL_PUNCT, '');
  return w ? { len: w.length, word: w } : null;
}

/* ------------------------------------------------------------------ */
/* Recurrence description                                               */
/* ------------------------------------------------------------------ */

const joinNl = (arr) => (arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' en ' + arr[arr.length - 1]);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Dutch, capitalized description of a recurrence rule. */
export function describeRecurrence(rec) {
  if (!rec || !rec.freq) return '';
  const n = Math.max(1, rec.interval | 0 || 1);
  switch (rec.freq) {
    case 'day': return n === 1 ? 'Elke dag' : `Elke ${n} dagen`;
    case 'week': {
      if (rec.workdays && n === 1) return 'Elke werkdag';
      const base = n === 1 ? 'Elke week' : `Elke ${n} weken`;
      if (rec.workdays) return base + ' op werkdagen';
      return rec.days && rec.days.length ? base + ' op ' + joinNl(rec.days.map((d) => WD_NL[d])) : base;
    }
    case 'month': {
      const base = n === 1 ? 'Elke maand' : `Elke ${n} maanden`;
      if (!rec.monthday) return base;
      return rec.monthday >= 31 ? base + ' op de laatste dag' : `${base} op de ${rec.monthday}e`;
    }
    case 'year': return n === 1 ? 'Elk jaar' : `Elke ${n} jaar`;
    default: return '';
  }
}

const weekDaysOf = (rec) => (rec.workdays ? [1, 2, 3, 4, 5] : rec.days && rec.days.length ? [...new Set(rec.days)].sort((a, b) => a - b) : null);

/** One step strictly after `from`. */
function stepRecurrence(rec, from) {
  const n = Math.max(1, rec.interval | 0 || 1);
  switch (rec.freq) {
    case 'day': return addDays(from, n);
    case 'week': {
      const days = weekDaysOf(rec);
      if (!days) return addDays(from, 7 * n);
      const w = isoWd(from);
      for (const d of days) if (d > w) return addDays(from, d - w);
      return addDays(mondayOf(from), 7 * n + days[0] - 1);
    }
    case 'month': {
      const [y, m, d] = ymd(from);
      const md = rec.monthday || d;
      const cand = makeDate(y, m, Math.min(md, dim(y, m)));
      if (cand > from) return cand;
      return addMonthsClamped(y, m, md, n);
    }
    case 'year': {
      const [y, m, d] = ymd(from);
      return makeDate(y + n, m, Math.min(d, dim(y + n, m)));
    }
    default: return null;
  }
}

/** First occurrence on/after `today` (used when quick add has a recurrence but no date). */
function firstOccurrence(rec, today) {
  if (rec.freq === 'week' && weekDaysOf(rec)) {
    return weekDaysOf(rec).includes(isoWd(today)) ? today : stepRecurrence({ ...rec, interval: 1 }, today);
  }
  if (rec.freq === 'month' && rec.monthday) {
    const [y, m] = ymd(today);
    const cand = makeDate(y, m, Math.min(rec.monthday, dim(y, m)));
    return cand >= today ? cand : addMonthsClamped(y, m, rec.monthday, 1);
  }
  return today;
}

/**
 * Next due date strictly after `fromDate`, and never before today: overdue tasks
 * advance (in phase with the rule) to the first occurrence >= today.
 */
export function nextOccurrence(recurrence, fromDate, opts = {}) {
  if (!recurrence || !recurrence.freq) return null;
  const today = todayStr(opts.now || new Date());
  let next = stepRecurrence(recurrence, fromDate || today);
  // Fast-forward daily rules; loop the rest (bounded).
  for (let guard = 0; next && next < today && guard < 100000; guard++) next = stepRecurrence(recurrence, next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Quick add                                                            */
/* ------------------------------------------------------------------ */

const DANGLING = /(?<![\p{L}\p{N}])(voor|op|om|vanaf|tegen|tot|uiterlijk|on|at|by|before|from|until)\s+$/iu;

/**
 * Parse Todoist-style quick add text.
 * @param {string} input
 * @param {{now?: Date, projects?: {id:any,name:string}[], labels?: string[]}} ctx
 */
export function parseQuickAdd(input, ctx = {}) {
  input = String(input ?? '');
  const now = ctx.now || new Date();
  const today = todayStr(now);
  const projects = ctx.projects || [];
  const knownLabels = ctx.labels || [];
  const claimed = []; // tokens
  const res = {
    title: '', due_date: null, due_time: null, recurrence: null, priority: null,
    project: null, new_project: null, section: null, labels: [], deadline: null,
    reminder: null, duration_min: null, tokens: claimed,
  };
  const claim = (start, end, type) => { claimed.push({ start, end, type, text: input.slice(start, end) }); };
  const each = (re, fn) => {
    re.lastIndex = 0; let m;
    while ((m = re.exec(input))) {
      const s = m.index, e = s + m[0].length;
      if (!overlaps(claimed, s, e) && fn(m, s, e) === false) break; // fn returns false = stop
      re.lastIndex = s + 1;
    }
  };

  // 1. Deadline: "{vrijdag}" or "deadline vrijdag"
  each(/\{([^{}]+)\}/g, (m, s, e) => {
    const r = parseDateText(m[1], now);
    if (r && r.due_date) { res.deadline = r.due_date; claim(s, e, 'deadline'); return false; }
  });
  if (!res.deadline) {
    each(new RegExp(PARTS.B + 'deadline:?\\s+', 'giu'), (m, s, e) => {
      const d = dateAt(input, e, claimed, today, now);
      if (d) { res.deadline = typeof d.val === 'string' ? d.val : d.val.date; claim(s, d.end, 'deadline'); return false; }
    });
  }

  // 2. Legacy priority "!!1", then reminders "!30m", "!1u", "!om 8:00", "!8:00"
  each(/(?<=^|\s)!!([1-4])(?=$|\s)/g, (m, s, e) => { res.priority = +m[1]; claim(s, e, 'priority'); return false; });
  let reminderTime = null;
  each(/(?<=^|\s)!(\d+)\s?(minuten|minutes|min|m|uur|u|h|dagen|dag|d)(?=$|\s|[,.;])/gi, (m, s, e) => {
    const u = m[2].toLowerCase(), n = +m[1];
    res.reminder = { minutes_before: u.startsWith('m') ? n : /^(u|h)/.test(u) ? n * 60 : n * 1440 };
    claim(s, e, 'reminder'); return false;
  });
  if (!res.reminder) {
    each(/(?<=^|\s)!(?:(?:om|at)\s+)?(\d{1,2})(?:[:.](\d{2}))?(uur|u|am|pm)?(?=$|\s|[,;])/gi, (m, s, e) => {
      let h = +m[1]; const mi = m[2] ? +m[2] : 0; const suf = m[3] && m[3].toLowerCase();
      if (suf === 'am' || suf === 'pm') { if (h < 1 || h > 12) return; h = (h % 12) + (suf === 'pm' ? 12 : 0); }
      if (h > 23 || mi > 59) return;
      reminderTime = `${pad(h)}:${pad(mi)}`; claim(s, e, 'reminder'); return false;
    });
  }

  // 3. Project "#Naam" (longest existing match, unique prefix, else new project)
  each(/(?<=^|\s)#/g, (m, s) => {
    const rest = input.slice(s + 1);
    const hit = sigilName(rest, projects.map((p) => p.name));
    if (!hit) return;
    if (hit.exact) {
      res.project = projects.find((p) => p.name === hit.exact);
    } else {
      if (/^\d+$/.test(hit.word)) return; // "Bug #42" is not a project
      const w = norm(hit.word);
      const pre = projects.filter((p) => norm(p.name).startsWith(w));
      if (pre.length === 1) res.project = pre[0];
      else res.new_project = hit.word;
    }
    claim(s, s + 1 + hit.len, 'project'); return false;
  });

  // 4. Labels "@label" (all of them; existing labels win for spelling and multi-word names)
  each(/(?<=^|\s)@/g, (m, s) => {
    const hit = sigilName(input.slice(s + 1), knownLabels);
    if (!hit) return;
    let name = hit.exact || hit.word;
    const known = knownLabels.find((l) => norm(l) === norm(name));
    if (known) name = known;
    if (!res.labels.some((l) => norm(l) === norm(name))) res.labels.push(name);
    claim(s, s + 1 + hit.len, 'label');
  });

  // 5. Section "/sectie"
  each(/(?<=^|\s)\/(\p{L}[^\s/#@]*)/gu, (m, s) => {
    const w = m[1].replace(TRAIL_PUNCT, '');
    res.section = w; claim(s, s + 1 + w.length, 'section'); return false;
  });

  // 6. Priority p1..p4
  if (res.priority == null) {
    each(/(?<=^|\s)[pP]([1-4])(?=$|\s|[,.;!?])/g, (m, s, e) => { res.priority = +m[1]; claim(s, e, 'priority'); return false; });
  }

  // 7. Duration "duur 30m", "duur 1u30", "for 45 min"
  each(new RegExp(PARTS.B + '(?:duur|for):?\\s+(\\d+(?:[.,]\\d+)?)\\s?(minuten|minutes|mins?|m|uur|hours?|u|h)(\\d{2})?' + PARTS.E, 'giu'), (m, s, e) => {
    const v = parseFloat(m[1].replace(',', '.')); const u = m[2].toLowerCase();
    const mins = /^m/.test(u) ? v : v * 60 + (m[3] ? +m[3] : 0);
    if (!(mins > 0)) return;
    res.duration_min = Math.round(mins); claim(s, e, 'duration'); return false;
  });

  // 8. Recurrence, 9. date, 10. time
  const rec = bestMatch(input, claimed, RECUR_PATTERNS, today, now);
  if (rec) { res.recurrence = rec.val; claim(rec.start, rec.end, 'recurrence'); }
  const dt = bestMatch(input, claimed, DATE_PATTERNS, today, now);
  let impliedTime = null;
  if (dt) {
    const v = typeof dt.val === 'string' ? { date: dt.val } : dt.val;
    res.due_date = v.date; impliedTime = v.time || null;
    claim(dt.start, dt.end, 'date');
  }
  const tm = bestMatch(input, claimed, TIME_PATTERNS, today, now);
  if (tm) { res.due_time = tm.val; claim(tm.start, tm.end, 'time'); }
  if (!res.due_time && impliedTime) res.due_time = impliedTime;

  // Resolve dates
  if (res.recurrence) {
    if (!res.due_date) res.due_date = firstOccurrence(res.recurrence, today);
    if (res.recurrence.freq === 'month' && !res.recurrence.monthday) res.recurrence.monthday = ymd(res.due_date)[2];
    const t = describeRecurrence(res.recurrence);
    res.recurrence.text = t[0].toLowerCase() + t.slice(1);
  }
  if (!res.due_date && res.due_time) res.due_date = res.due_time > nowHM(now) ? today : addDays(today, 1);
  if (reminderTime) {
    const date = res.due_date || (reminderTime > nowHM(now) ? today : addDays(today, 1));
    res.reminder = { at: `${date}T${reminderTime}` };
  }

  // Title: remove tokens (+ dangling preposition before a trailing date token)
  claimed.sort((a, b) => a.start - b.start);
  const remove = claimed.map((t) => [t.start, t.end]);
  const isRemoved = (i) => remove.some(([s, e]) => i >= s && i < e);
  const restIsEmpty = (from) => { for (let i = from; i < input.length; i++) if (!isRemoved(i) && /[^\s,;.\-–]/.test(input[i])) return false; return true; };
  for (const t of claimed) {
    if (!['date', 'time', 'recurrence', 'deadline'].includes(t.type)) continue;
    const m = DANGLING.exec(input.slice(0, t.start));
    if (m && !isRemoved(t.start - m[0].length) && restIsEmpty(t.end)) remove.push([t.start - m[0].length, t.start]);
  }
  let title = '';
  for (let i = 0; i < input.length; i++) title += isRemoved(i) ? ' ' : input[i];
  title = title.replace(/\s+/g, ' ').replace(/\s+([,;:.!?])/g, '$1').trim();
  if (claimed.length) title = title.replace(/^[,;:\-–\s]+|[,;:\-–\s]+$/g, '').trim();
  // "Op maandag bellen" -> "Bellen": keep the sentence capital when a leading token was removed.
  if (claimed.length && /^\s*\p{Lu}/u.test(input) && isRemoved(input.search(/\S/)) && /^\p{Ll}/u.test(title)) title = cap(title);
  res.title = title;
  return res;
}

/* ------------------------------------------------------------------ */
/* Date box parsing & formatting                                        */
/* ------------------------------------------------------------------ */

/** Parse a whole string as a date phrase (task detail date box). */
export function parseDateText(text, now = new Date()) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/^(geen(\s+datum)?|zonder\s+datum|no\s+date|none|wissen)$/i.test(t)) {
    return { due_date: null, due_time: null, recurrence: null, cleared: true };
  }
  const r = parseQuickAdd(t, { now });
  if (r.title !== '' || !r.tokens.length) return null;
  if (!r.tokens.every((k) => k.type === 'date' || k.type === 'time' || k.type === 'recurrence')) return null;
  return { due_date: r.due_date, due_time: r.due_time, recurrence: r.recurrence };
}

function shortDate(str, now) {
  const [y, m, d] = ymd(str);
  return `${d} ${MONTH_NL_SHORT[m]}` + (y !== now.getFullYear() ? ` ${y}` : '');
}

/** { text, tone } for a due date chip. tone: overdue|today|tomorrow|week|later|none. */
export function formatDue(due_date, due_time, now = new Date()) {
  if (!due_date) return { text: '', tone: 'none' };
  const d = diffDays(todayStr(now), due_date);
  let text, tone;
  if (d < 0) { tone = 'overdue'; text = d === -1 ? 'Gisteren' : shortDate(due_date, now); }
  else if (d === 0) { tone = 'today'; text = 'Vandaag'; }
  else if (d === 1) { tone = 'tomorrow'; text = 'Morgen'; }
  else if (d <= 6) { tone = 'week'; text = cap(WD_NL[isoWd(due_date)]); }
  else { tone = 'later'; text = shortDate(due_date, now); }
  if (due_time) text += ' ' + due_time;
  return { text, tone };
}

/** "Donderdag 14 november" (+ year if not the current year). */
export function formatDateLong(date, now = new Date()) {
  if (!date) return '';
  const [y, m, d] = ymd(date);
  return `${cap(WD_NL[isoWd(date)])} ${d} ${MONTH_NL[m]}` + (y !== now.getFullYear() ? ` ${y}` : '');
}

/* ------------------------------------------------------------------ */
/* Filters                                                              */
/* ------------------------------------------------------------------ */
// Grammar: or := and ('|' and)* ; and := not ('&' not)* ; not := '!' not | '(' or ')' | term

class FilterError extends Error {}

function lexFilter(q) {
  const toks = []; let buf = '';
  const flush = () => { const t = buf.trim(); if (t) toks.push({ k: 'term', v: t }); buf = ''; };
  for (const ch of q) {
    if (ch === '(' || ch === ')' || ch === '|' || ch === '&') { flush(); toks.push({ k: ch }); }
    else if (ch === '!' && buf.trim() === '') { buf = ''; toks.push({ k: '!' }); }
    else buf += ch;
  }
  flush();
  return toks;
}

const wildcard = (pat) => new RegExp('^' + pat.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const prio = (t) => (t.priority >= 1 && t.priority <= 4 ? t.priority : 4);

function compileTerm(raw, now) {
  const t = raw.trim().replace(/\s+/g, ' ');
  const l = t.toLowerCase();
  const today = todayStr(now);
  let m;
  if (/^(alle|all|alles)$/.test(l)) return () => true;
  if (/^(vandaag|today)$/.test(l)) return (k) => k.due_date === today;
  if (/^(morgen|tomorrow)$/.test(l)) { const d = addDays(today, 1); return (k) => k.due_date === d; }
  if (/^(achterstallig|te laat|overdue|verlopen)$/.test(l)) return (k) => !!k.due_date && k.due_date < today;
  if (/^(geen datum|zonder datum|no date|no due date)$/.test(l)) return (k) => !k.due_date;
  if (/^(met datum|heeft datum|has date|has due date)$/.test(l)) return (k) => !!k.due_date;
  if ((m = l.match(/^(?:(?:volgende|komende|next)\s+)?(\d+)\s+(dagen|dag|days|day)$/))) {
    const end = addDays(today, Math.max(1, +m[1]) - 1);
    return (k) => !!k.due_date && k.due_date >= today && k.due_date <= end;
  }
  if ((m = l.match(/^p([1-4])$/)) || (m = l.match(/^(?:prioriteit|priority)\s*([1-4])$/))) { const p = +m[1]; return (k) => prio(k) === p; }
  if (/^(geen labels|zonder labels|no labels)$/.test(l)) return (k) => !(k.labels && k.labels.length);
  if (/^(terugkerend|herhalend|recurring)$/.test(l)) return (k) => !!k.recurrence;
  if (/^(subtaak|subtaken|subtask|subtasks)$/.test(l)) return (k) => k.parent_id != null;
  if ((m = t.match(/^(?:zoek|zoeken|search)\s*:\s*(.+)$/i))) {
    const w = m[1].trim().toLowerCase();
    return (k) => ((k.title || '') + '\n' + (k.description || '')).toLowerCase().includes(w);
  }
  if (t.startsWith('#')) {
    const name = t.replace(/^#+/, '').trim();
    if (!name) throw new FilterError('Projectnaam ontbreekt na “#”');
    const rx = wildcard(name);
    const isInbox = rx.test('inbox');
    return (k, env) => {
      if (k.project_id == null) return isInbox;
      const p = env.projectsById && env.projectsById[k.project_id];
      return !!p && rx.test(String(p.name).toLowerCase());
    };
  }
  if (t.startsWith('@')) {
    const name = t.slice(1).trim();
    if (!name) throw new FilterError('Labelnaam ontbreekt na “@”');
    const rx = wildcard(name);
    return (k) => (k.labels || []).some((x) => rx.test(String(x).toLowerCase()));
  }
  if (t.startsWith('/')) {
    const name = t.slice(1).trim();
    if (!name) throw new FilterError('Sectienaam ontbreekt na “/”');
    const rx = wildcard(name);
    return (k, env) => { const s = k.section_id != null && env.sectionsById && env.sectionsById[k.section_id]; return !!s && rx.test(String(s.name).toLowerCase()); };
  }
  if ((m = t.match(/^(voor|before|na|after|datum|date|op|on)\s*:?\s*(.+)$/i))) {
    const r = parseDateText(m[2], now);
    if (r && r.due_date) {
      const d = r.due_date, op = m[1].toLowerCase();
      if (op === 'voor' || op === 'before') return (k) => !!k.due_date && k.due_date < d;
      if (op === 'na' || op === 'after') return (k) => !!k.due_date && k.due_date > d;
      return (k) => k.due_date === d;
    }
  }
  const r = parseDateText(t, now);
  if (r && r.due_date && !r.recurrence) { const d = r.due_date; return (k) => k.due_date === d; }
  throw new FilterError(`Onbekende term: “${t}”`);
}

function compileFilter(query, now) {
  const toks = lexFilter(String(query ?? ''));
  if (!toks.length) throw new FilterError('Lege filter');
  let i = 0;
  const peek = () => toks[i] && toks[i].k;
  const parseOr = () => {
    let left = parseAnd();
    while (peek() === '|') { i++; const a = left, b = parseAnd(); left = (k, e) => a(k, e) || b(k, e); }
    return left;
  };
  const parseAnd = () => {
    let left = parseNot();
    while (peek() === '&') { i++; const a = left, b = parseNot(); left = (k, e) => a(k, e) && b(k, e); }
    return left;
  };
  const parseNot = () => {
    const k = peek();
    if (k === '!') { i++; const f = parseNot(); return (t, e) => !f(t, e); }
    if (k === '(') {
      i++; const f = parseOr();
      if (peek() !== ')') throw new FilterError('Haakje “)” ontbreekt');
      i++; return f;
    }
    if (k === 'term') return compileTerm(toks[i++].v, now);
    if (k == null) throw new FilterError('Filter eindigt onverwacht');
    throw new FilterError(`Onverwacht “${k}”`);
  };
  const f = parseOr();
  if (i < toks.length) throw new FilterError(`Onverwacht “${toks[i].k === 'term' ? toks[i].v : toks[i].k}”`);
  return f;
}

const filterCache = new Map();
function getFilter(query, now) {
  const key = todayStr(now) + '\u0000' + query;
  let f = filterCache.get(key);
  if (!f) {
    try { f = compileFilter(query, now); } catch (e) { f = e instanceof FilterError ? e : new FilterError(String(e && e.message || e)); }
    if (filterCache.size > 100) filterCache.clear();
    filterCache.set(key, f);
  }
  return f;
}

/** Does a task match a Todoist-like filter query? Malformed queries never match (no throw). */
export function matchesFilter(task, query, ctx = {}) {
  if (!task || task.completed) return false;
  const f = getFilter(query, ctx.now || new Date());
  if (f instanceof Error) return false;
  try {
    return !!f(task, { projectsById: ctx.projectsById || {}, sectionsById: ctx.sectionsById || {} });
  } catch { return false; }
}

/** Check a filter query; error message in Dutch. */
export function validateFilter(query) {
  const f = getFilter(query, new Date());
  return f instanceof Error ? { ok: false, error: f.message } : { ok: true };
}
