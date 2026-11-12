// Ochtendoverzicht: één melding per dag op het gekozen tijdstip
// (Europe/Amsterdam) met de taken van vandaag en wat achterstallig is.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const TZ = "Europe/Amsterdam";
// Hoe lang na het gekozen tijdstip het overzicht nog verstuurd mag worden.
// Zet je het om 23:00 aan met tijd 08:00, dan komt het pas de volgende ochtend.
const WINDOW_MIN = 180;

export function amsterdamNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

type Task = { title: string; priority: number; due_date: string; due_time: string | null };

export function digestText(today: Task[], overdue: Task[]) {
  const n = today.length;
  const o = overdue.length;
  if (!n && !o) {
    return { title: "Goedemorgen", body: "Niets gepland voor vandaag." };
  }
  const head = [
    n ? `${n} ${n === 1 ? "taak" : "taken"} vandaag` : "Niets nieuws vandaag",
    o ? `${o} achterstallig` : "",
  ].filter(Boolean).join(", ");
  // Belangrijkste eerst: achterstallig, dan prioriteit, dan tijd.
  const byImportance = (a: Task, b: Task) =>
    a.priority - b.priority || (a.due_time ?? "99").localeCompare(b.due_time ?? "99");
  const top = [...[...overdue].sort(byImportance), ...[...today].sort(byImportance)]
    .slice(0, 3)
    .map((t) => (t.due_time ? `${t.due_time.slice(0, 5)} ${t.title}` : t.title));
  const more = n + o - top.length;
  return {
    title: "Goedemorgen",
    body: `${head}.\n${top.join("\n")}${more > 0 ? `\n+${more} meer` : ""}`,
  };
}

export async function runDigests(
  sb: SupabaseClient,
  send: (userId: string, payload: Record<string, unknown>) => Promise<number>,
  now = new Date(),
) {
  const { date, minutes } = amsterdamNow(now);
  const { data: settings, error } = await sb.from("user_settings")
    .select("user_id, digest_time, last_digest_date")
    .eq("digest_enabled", true);
  if (error) throw error;

  let sent = 0;
  for (const s of settings ?? []) {
    const start = toMinutes(s.digest_time);
    if (minutes < start || minutes > start + WINDOW_MIN) continue;
    if (s.last_digest_date && s.last_digest_date >= date) continue;

    // Claimen: maar één aanroep per dag mag hem versturen.
    const { data: claimed } = await sb.from("user_settings")
      .update({ last_digest_date: date })
      .eq("user_id", s.user_id)
      .or(`last_digest_date.is.null,last_digest_date.lt.${date}`)
      .select("user_id");
    if (!claimed?.length) continue;

    const { data: tasks } = await sb.from("tasks")
      .select("title, priority, due_date, due_time")
      .eq("user_id", s.user_id)
      .eq("completed", false)
      .is("parent_id", null)
      .lte("due_date", date);
    const all = (tasks ?? []) as Task[];
    const { title, body } = digestText(
      all.filter((t) => t.due_date === date),
      all.filter((t) => t.due_date < date),
    );
    sent += await send(s.user_id, { title, body, url: "#/vandaag", tag: "nota-ochtend" });
  }
  return sent;
}
