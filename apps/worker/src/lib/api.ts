import type { Env } from "../env";
import type { JobSourceSpec, UserConfig } from "@jobfinder/shared";
import { runPipeline, type BatchResult } from "./runUser";
import { bearerToken, createSessionToken, EMAIL_RE, hashPassword, verifyPassword, verifySessionToken } from "./auth";

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
    const link = await env.DB.prepare(`SELECT status, created_at, user_id FROM bot_links WHERE token = ?`).bind(startPayload)
      .first<{ status: string; created_at: number; user_id: string }>();
    const stale = !link || link.status !== "pending" || now - link.created_at > 15 * 60 * 1000;
    if (stale) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, String(msg.chat.id),
        "⏳ Ye link expire ho gaya (15 min purana). Website pe naya 'Connect Bot' button dabao.", fetch).catch(() => {});
      return Response.json({ ok: true });
    }
    const chatId = String(msg.chat.id);
    await env.DB.prepare(`UPDATE bot_links SET status = 'linked', chat_id = ?, telegram_username = ?, linked_at = ? WHERE token = ?`)
      .bind(chatId, msg.chat.username ?? null, now, startPayload).run();
    await env.DB.prepare(`UPDATE configs SET telegram_chat_id = ? WHERE user_id = ?`).bind(chatId, link.user_id).run();
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      "✅ Bot connected! Website pe wapas jaake refresh karo — ab tumhare job matches yahin aayenge. Job Finder rock karo! 🚀", fetch).catch(() => {});
    return Response.json({ ok: true });
  }

  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  // ---- Accounts / sessions (called by the web app via internal token) ----

  if (path === "/auth/signup" && req.method === "POST") {
    const body = (await req.json()) as { email?: string; password?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!EMAIL_RE.test(email)) return Response.json({ error: "invalid email" }, { status: 400 });
    if (password.length < 8) return Response.json({ error: "password must be at least 8 characters" }, { status: 400 });
    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
    if (existing) return Response.json({ error: "email already registered" }, { status: 409 });
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`)
      .bind(id, email, passwordHash, Date.now()).run();
    const sessionToken = await createSessionToken(id, env.AUTH_SECRET);
    return Response.json({ token: sessionToken, user: { id, email } });
  }

  if (path === "/auth/login" && req.method === "POST") {
    const body = (await req.json()) as { email?: string; password?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const row = await env.DB.prepare(`SELECT id, password_hash FROM users WHERE email = ?`).bind(email)
      .first<{ id: string; password_hash: string }>();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return Response.json({ error: "invalid email or password" }, { status: 401 });
    }
    const sessionToken = await createSessionToken(row.id, env.AUTH_SECRET);
    return Response.json({ token: sessionToken, user: { id: row.id, email } });
  }

  if (path === "/auth/me" && req.method === "GET") {
    const session = bearerToken(req);
    const userId = session ? await verifySessionToken(session, env.AUTH_SECRET) : null;
    if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
    const row = await env.DB.prepare(`SELECT id, email FROM users WHERE id = ?`).bind(userId)
      .first<{ id: string; email: string }>();
    if (!row) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ id: row.id, email: row.email });
  }

  // Acting user for user-scoped routes: Bearer session wins; internal callers
  // (cron, orchestration) may act on any user via x-user-id. Legacy default 'owner'.
  // A presented-but-invalid session never downgrades — reject it outright.
  const authHeader = req.headers.get("authorization");
  const sessionUser = authHeader?.startsWith("Bearer ")
    ? await verifySessionToken(authHeader.slice("Bearer ".length), env.AUTH_SECRET)
    : null;
  if (authHeader && !sessionUser) return Response.json({ error: "unauthorized" }, { status: 401 });
  const userId = sessionUser ?? (authorized ? (req.headers.get("x-user-id") ?? "owner") : null);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (path === "/config" && req.method === "GET") {
    const row = await env.DB.prepare(`SELECT * FROM configs WHERE user_id = ?`).bind(userId).first<Record<string, string | number | null>>();
    if (!row) return Response.json({ userId, fields: [], skills: [], sites: [], filters: {}, scoreThreshold: 70, cadenceHours: 1, isActive: false, telegramChatId: null });
    return Response.json({
      userId,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET fields=excluded.fields, skills=excluded.skills, sites=excluded.sites,
         filters=excluded.filters, score_threshold=excluded.score_threshold, cadence_hours=excluded.cadence_hours,
         is_active=excluded.is_active, telegram_chat_id=excluded.telegram_chat_id, updated_at=excluded.updated_at`
    ).bind(
      userId,
      JSON.stringify(body.fields ?? []), JSON.stringify(body.skills ?? []), JSON.stringify(body.sites ?? []),
      JSON.stringify(body.filters ?? {}), Number(body.scoreThreshold ?? 70), Number(body.cadenceHours ?? 1),
      body.isActive ? 1 : 0, Number(body.nextRunAt ?? 0), (body.telegramChatId as string) ?? null, now,
    ).run();
    return Response.json({ ok: true });
  }

  if (path === "/runs" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const rows = await env.DB.prepare(`SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`).bind(userId, limit).all();
    return Response.json(rows.results);
  }

  if (path === "/run-user" && req.method === "POST") {
    const { runUser } = await import("./runUser");
    const result = await runUser({ db: env.DB, env, userId });
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
    await env.DB.prepare(`INSERT INTO bot_links (token, user_id, status, created_at) VALUES (?, ?, 'pending', ?)`)
      .bind(token, userId, now).run();
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
