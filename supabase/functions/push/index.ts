// Nota: herinneringen en ochtendoverzicht als pushmelding.
//  GET              -> { publicKey }            (VAPID-sleutel voor de app)
//  POST {test:true} -> testmelding naar eigen apparaten (met login-token)
//  POST + x-cron-secret -> verstuurt alle herinneringen die nu aan de beurt zijn
//                          en het ochtendoverzicht (elke minuut via pg_cron)
// Doet zelf de controle op toegang, daarom verify_jwt uit.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { runDigests } from "./digest.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function getConfig(key: string): Promise<string | null> {
  const { data } = await sb.from("push_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// VAPID-sleutels worden de eerste keer zelf gemaakt en in push_config
// bewaard. Zo komt de geheime sleutel nooit buiten de server.
let vapidReady: Promise<string> | null = null;
function ensureVapid(): Promise<string> {
  if (!vapidReady) {
    vapidReady = (async () => {
      let pub = await getConfig("vapid_public");
      let priv = await getConfig("vapid_private");
      if (!pub || !priv) {
        const keys = webpush.generateVAPIDKeys();
        await sb.from("push_config").upsert(
          [
            { key: "vapid_public", value: keys.publicKey },
            { key: "vapid_private", value: keys.privateKey },
          ],
          { onConflict: "key", ignoreDuplicates: true },
        );
        pub = await getConfig("vapid_public");
        priv = await getConfig("vapid_private");
      }
      webpush.setVapidDetails("https://www.dionvijverberg.nl/nota/", pub!, priv!);
      return pub!;
    })().catch((e) => {
      vapidReady = null;
      throw e;
    });
  }
  return vapidReady;
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

async function sendTo(subs: Sub[], payload: Record<string, unknown>) {
  let sent = 0;
  const errors: string[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Abonnement bestaat niet meer (app verwijderd, meldingen uit): opruimen.
      if (code === 404 || code === 410) {
        await sb.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        errors.push(`${code ?? ""} ${(e as Error).message}`.trim());
      }
    }
  }
  return { sent, errors };
}

async function sendToUser(userId: string, payload: Record<string, unknown>) {
  const { data: subs } = await sb.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth").eq("user_id", userId);
  if (!subs?.length) return 0;
  return (await sendTo(subs, payload)).sent;
}

function fmtTime(t: string | null) {
  return t ? t.slice(0, 5) : "";
}

async function runReminders() {
  const { data: due, error } = await sb.rpc("due_reminders");
  if (error) throw error;
  let sent = 0;
  for (const r of due ?? []) {
    // Eerst "claimen", zodat een overlappende aanroep niet dubbel meldt.
    const { data: claimed } = await sb.from("tasks")
      .update({ reminder_sent_for: r.remind_at })
      .eq("id", r.task_id)
      .or(`reminder_sent_for.is.null,reminder_sent_for.neq.${r.remind_at}`)
      .select("id");
    if (!claimed?.length) continue;

    const parts = [fmtTime(r.due_time), r.project_name ?? "Inbox"].filter(Boolean);
    sent += await sendToUser(r.user_id, {
      title: r.title,
      body: parts.join(" · "),
      url: `#/taak/${r.task_id}`,
      tag: `taak-${r.task_id}`,
      taskId: r.task_id,
    });
  }
  return { reminders: due?.length ?? 0, sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (req.method === "GET") {
      return json({ publicKey: await ensureVapid() });
    }

    if (req.method !== "POST") return json({ error: "methode niet toegestaan" }, 405);

    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret) {
      if (cronSecret !== (await getConfig("cron_secret"))) return json({ error: "geen toegang" }, 401);
      await ensureVapid();
      const result = await runReminders();
      // Een fout in het overzicht mag de herinneringen niet tegenhouden.
      let digests = 0;
      try {
        digests = await runDigests(sb, sendToUser);
      } catch (e) {
        console.error("ochtendoverzicht mislukt", e);
      }
      return json({ ...result, digests });
    }

    // Testmelding vanuit de app: alleen met een geldige login.
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData } = await sb.auth.getUser(token);
    const user = userData?.user;
    if (!user) return json({ error: "log opnieuw in" }, 401);

    const body = await req.json().catch(() => ({}));
    if (!body?.test) return json({ error: "onbekend verzoek" }, 400);

    await ensureVapid();
    const { data: subs } = await sb.from("push_subscriptions")
      .select("id, endpoint, p256dh, auth").eq("user_id", user.id);
    if (!subs?.length) return json({ error: "meldingen staan op geen enkel apparaat aan" }, 400);
    const res = await sendTo(subs, {
      title: "Meldingen werken",
      body: "Zo zie je straks je herinneringen.",
      url: "#/vandaag",
      tag: "nota-test",
    });
    if (!res.sent) return json({ error: res.errors[0] ?? "versturen mislukt" }, 502);
    return json(res);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
