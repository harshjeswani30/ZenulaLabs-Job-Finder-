import type { Env } from "../env";

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const token = req.headers.get("x-internal-token");
  const authorized = token === env.INTERNAL_TOKEN;

  if (path === "/health") return Response.json({ ok: true });

  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (path === "/config" && req.method === "GET") {
    const row = await env.DB.prepare(`SELECT * FROM configs WHERE user_id='owner'`).first<Record<string, string | number | null>>();
    if (!row) return Response.json({ userId: "owner", fields: [], skills: [], sites: [], filters: {}, scoreThreshold: 70, cadenceHours: 1, isActive: false, telegramChatId: null });
    return Response.json({
      userId: "owner",
      fields: JSON.parse(String(row.fields)),
      skills: JSON.parse(String(row.skills)),
      sites: JSON.parse(String(row.sites)),
      filters: JSON.parse(String(row.filters)),
      scoreThreshold: Number(row.score_threshold),
      cadenceHours: Number(row.cadence_hours),
      isActive: Number(row.is_active) === 1,
      telegramChatId: row.telegram_chat_id ?? null,
    });
  }

  if (path === "/config" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
       VALUES ('owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET fields=excluded.fields, skills=excluded.skills, sites=excluded.sites,
         filters=excluded.filters, score_threshold=excluded.score_threshold, cadence_hours=excluded.cadence_hours,
         is_active=excluded.is_active, telegram_chat_id=excluded.telegram_chat_id, updated_at=excluded.updated_at`
    ).bind(
      JSON.stringify(body.fields ?? []), JSON.stringify(body.skills ?? []), JSON.stringify(body.sites ?? []),
      JSON.stringify(body.filters ?? {}), Number(body.scoreThreshold ?? 70), Number(body.cadenceHours ?? 1),
      body.isActive ? 1 : 0, Number(body.nextRunAt ?? 0), (body.telegramChatId as string) ?? null, now,
    ).run();
    return Response.json({ ok: true });
  }

  if (path === "/runs" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const rows = await env.DB.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).bind(limit).all();
    return Response.json(rows.results);
  }

  if (path === "/run-user" && req.method === "POST") {
    const { runUser } = await import("./runUser");
    const result = await runUser({ db: env.DB, env });
    return Response.json(result);
  }

  if (path === "/telegram-test" && req.method === "POST") {
    const { chatId } = (await req.json()) as { chatId: string };
    if (!chatId || typeof chatId !== "string") {
      return Response.json({ error: "chatId required" }, { status: 400 });
    }
    const { sendTelegramMessage } = await import("./telegram");
    try {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "✅ Job Finder connected!", fetch);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "telegram send failed" }, { status: 500 });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
