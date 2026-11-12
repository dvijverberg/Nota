// Taken -> iCalendar (RFC 5545). Los bestand zodat het te testen is.

export type Task = {
  id: string;
  title: string;
  description: string | null;
  due_date: string;              // YYYY-MM-DD
  due_time: string | null;       // HH:MM[:SS]
  duration_min: number | null;
  recurrence: {
    freq?: string; interval?: number; days?: number[];
    monthday?: number; workdays?: boolean;
  } | null;
  completed: boolean;
  priority: number;
  updated_at: string;
  project_name?: string | null;
};

const TZID = "Europe/Amsterdam";
const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const FREQ: Record<string, string> = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" };

export function escapeText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Regels langer dan 75 bytes vouwen (vereist door de standaard).
export function fold(line: string) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // vervolgregels beginnen met een spatie
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function compactDate(d: string) {
  return d.replaceAll("-", "");
}

function addDays(d: string, n: number) {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day + n));
  return dt.toISOString().slice(0, 10);
}

function stamp(iso: string) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function rrule(rec: Task["recurrence"]): string | null {
  if (!rec?.freq || !FREQ[rec.freq]) return null;
  const parts = [`FREQ=${FREQ[rec.freq]}`];
  if (rec.interval && rec.interval > 1) parts.push(`INTERVAL=${rec.interval}`);
  if (rec.workdays) parts.push("BYDAY=MO,TU,WE,TH,FR");
  else if (rec.freq === "week" && rec.days?.length) {
    parts.push(`BYDAY=${rec.days.filter((d) => d >= 1 && d <= 7).map((d) => DAYS[d - 1]).join(",")}`);
  }
  if (rec.freq === "month" && rec.monthday) {
    parts.push(`BYMONTHDAY=${rec.monthday >= 31 ? -1 : rec.monthday}`);
  }
  return parts.join(";");
}

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${TZID}`,
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

export function buildCalendar(tasks: Task[], appUrl: string, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nota//Taken//NL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Nota",
    `X-WR-TIMEZONE:${TZID}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...VTIMEZONE,
  ];

  for (const t of tasks) {
    const ev = [
      "BEGIN:VEVENT",
      `UID:${t.id}@nota`,
      `DTSTAMP:${stamp(t.updated_at || now.toISOString())}`,
      `LAST-MODIFIED:${stamp(t.updated_at || now.toISOString())}`,
    ];
    if (t.due_time) {
      const hhmm = t.due_time.slice(0, 5).replace(":", "");
      ev.push(`DTSTART;TZID=${TZID}:${compactDate(t.due_date)}T${hhmm}00`);
      ev.push(`DURATION:PT${Math.max(5, t.duration_min || 30)}M`);
    } else {
      ev.push(`DTSTART;VALUE=DATE:${compactDate(t.due_date)}`);
      ev.push(`DTEND;VALUE=DATE:${compactDate(addDays(t.due_date, 1))}`);
      // Hele-dag-taken blokkeren je agenda niet.
      ev.push("TRANSP:TRANSPARENT");
    }
    const rule = !t.completed ? rrule(t.recurrence) : null;
    if (rule) ev.push(`RRULE:${rule}`);
    ev.push(`SUMMARY:${escapeText((t.completed ? "✓ " : "") + t.title)}`);
    const desc = [t.description?.trim(), t.project_name ? `Project: ${t.project_name}` : "Inbox"]
      .filter(Boolean).join("\n\n");
    ev.push(`DESCRIPTION:${escapeText(desc)}`);
    ev.push(`URL:${appUrl}#/taak/${t.id}`);
    if (t.priority >= 1 && t.priority <= 3) ev.push(`PRIORITY:${[1, 3, 5][t.priority - 1]}`);
    ev.push("END:VEVENT");
    lines.push(...ev);
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
