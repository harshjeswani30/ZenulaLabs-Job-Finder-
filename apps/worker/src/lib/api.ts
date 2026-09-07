import type { Env } from "../env";
import type { JobSourceSpec, UserConfig } from "@jobfinder/shared";
import { runPipeline, type BatchResult } from "./runUser";

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const token = req.headers.get("x-internal-token");
  const authorized = token === env.INTERNAL_TOKEN;

  if (path === "/health") return Response.json({ ok: true });

  // Telegram webhook — secret path segment replaces the x-internal-token gate
  // (Telegram can't send that header; only the bot token holder knows the URL).
  if (path === `/telegram/webhook/${env.INTERNAL_TOKEN}` && req.method === "POST") {
    const update = (await req.json()) as {
      message?: { chat?: { id?: number; username?: string }; text?: string };
    };
    const msg = update.message;
    const startPayload = msg?.text?.startsWith("/start ") ? msg.text.slice("/start ".length).trim() : (msg?.text === "/start" ? "" : undefined);
    if (!msg?.chat?.id || startPayload === undefined) {
      return Response.json({ ok: true }); // ignore non-start updates
    }
    const { sendTelegramMessage } = await import("./telegram");
    if (!startPayload) {
      // plain /start without token — guide the user
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, String(msg.chat.id),
        "👋 Namaste! Job Finder bot he.\nWebsite pe '📲 Connect Bot' button dabao — wahan se link kholega, phir yahan START pe click karoge toh account connect ho jayega.", fetch).catch(() => {});
      return Response.json({ ok: true });
    }
    const now = Date.now();
    const link = await env.DB.prepare(`SELECT status, created_at FROM bot_links WHERE token = ?`).bind(startPayload)
      .first<{ status: string; created_at: number }>();
    const stale = !link || link.status !== "pending" || now - link.created_at > 15 * 60 * 1000;
    if (stale) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, String(msg.chat.id),
        "⏳ Ye link expire ho gaya (15 min purana). Website pe naya 'Connect Bot' button dabao.", fetch).catch(() => {});
      return Response.json({ ok: true });
    }
    const chatId = String(msg.chat.id);
    await env.DB.prepare(`UPDATE bot_links SET status = 'linked', chat_id = ?, telegram_username = ?, linked_at = ? WHERE token = ?`)
      .bind(chatId, msg.chat.username ?? null, now, startPayload).run();
    await env.DB.prepare(`UPDATE configs SET telegram_chat_id = ? WHERE user_id = 'owner'`).bind(chatId).run();
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      "✅ Bot connected! Website pe wapas jaake refresh karo — ab tumhare job matches yahin aayenge. Job Finder rock karo! 🚀", fetch).catch(() => {});
    return Response.json({ ok: true });
  }

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

  if (path === "/run-batch" && req.method === "POST") {
    // One fan-out slice of a /run-user orchestration: fetch→dedupe→store→score→send
    // for the given source specs. The orchestrator owns the runs-row write.
    const body = (await req.json()) as {
      specs: JobSourceSpec[];
      runId: string;
      config: UserConfig;
      chatId: string;
    };
    if (!Array.isArray(body.specs) || body.specs.length === 0 || !body.config || !body.chatId) {
      return Response.json({ error: "specs, config, chatId required" }, { status: 400 });
    }
    const result: BatchResult = await runPipeline({ db: env.DB, env }, body.specs, body.config, body.chatId);
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

  // ---- Bot Connect flow (web button → t.me deep link → START → webhook links chat) ----

  const BOT_LINK_TTL_MS = 15 * 60 * 1000;

  // Start a connect session: creates a one-time token and returns the t.me deep link.
  if (path === "/bot/connect" && req.method === "POST") {
    const token = crypto.randomUUID().replace(/-/g, "");
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO bot_links (token, user_id, status, created_at) VALUES (?, 'owner', 'pending', ?)`)
      .bind(token, now).run();
    // bot username for the deep link (e.g. zenulalabsbot) — cached per request
    let botUsername = "";
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
      if (body.ok && body.result?.username) botUsername = body.result.username;
    } catch { /* leave empty — caller shows fallback */ }
    if (!botUsername) {
      return Response.json({ error: "could not resolve bot username — check TELEGRAM_BOT_TOKEN" }, { status: 502 });
    }
    return Response.json({ token, link: `https://t.me/${botUsername}?start=${token}`, expiresAt: now + BOT_LINK_TTL_MS });
  }

  // Poll a connect session's state: web UI calls this until status becomes linked.
  if (path.startsWith("/bot/status/") && req.method === "GET") {
    const linkToken = path.slice("/bot/status/".length);
    const row = await env.DB.prepare(`SELECT status, chat_id, telegram_username, linked_at FROM bot_links WHERE token = ?`).bind(linkToken)
      .first<{ status: string; chat_id: string | null; telegram_username: string | null; linked_at: number | null }>();
    if (!row) return Response.json({ status: "unknown" });
    return Response.json(row);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
