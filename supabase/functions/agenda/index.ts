// Nota: agenda-feed. GET ?token=<geheime link-code> -> .ics met je taken
// die een datum hebben (open, plus de afgelopen 14 dagen voltooid).
// Geen login: de lange, geheime token in de link is de toegang. Een nieuwe
// link maken in de app maakt de oude ongeldig.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildCalendar, type Task } from "./ics.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const APP_URL = "https://www.dionvijverberg.nl/nota/";

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Methode niet toegestaan", { status: 405 });
  }
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
    return new Response("Ongeldige link", { status: 401 });
  }

  const { data: settings } = await sb.from("user_settings")
    .select("user_id").eq("calendar_token", token).maybeSingle();
  if (!settings) return new Response("Deze agenda-link bestaat niet (meer)", { status: 404 });

  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const { data: rows, error } = await sb.from("tasks")
    .select("id, title, description, due_date, due_time, duration_min, recurrence, completed, completed_at, priority, updated_at, projects(name)")
    .eq("user_id", settings.user_id)
    .not("due_date", "is", null)
    .or(`completed.eq.false,completed_at.gte.${since}`)
    .order("due_date")
    .limit(2000);
  if (error) {
    console.error(error);
    return new Response("Agenda tijdelijk niet beschikbaar", { status: 500 });
  }

  const tasks: Task[] = (rows ?? []).map((r: Record<string, unknown>) => ({
    ...(r as unknown as Task),
    project_name: (r.projects as { name?: string } | null)?.name ?? null,
  }));

  return new Response(req.method === "HEAD" ? null : buildCalendar(tasks, APP_URL), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="nota.ics"',
      "Cache-Control": "private, max-age=600",
    },
  });
});
