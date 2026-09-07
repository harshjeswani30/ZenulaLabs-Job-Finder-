import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";

const H = { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" };

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM configs; DELETE FROM jobs; DELETE FROM user_jobs; DELETE FROM runs; DELETE FROM bot_links;`);
});

describe("api", () => {
  it("health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
  });

  it("rejects run-user without internal token", async () => {
    const res = await SELF.fetch("https://example.com/run-user", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("run-batch rejects without internal token", async () => {
    const res = await SELF.fetch("https://example.com/run-batch", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(401);
  });

  describe("bot connect flow", () => {
    /** Mock for getMe + sendMessage — returns whatever Telegram-shaped body each call needs. */
    function telegramMock() {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
        const u = String(input);
        if (u.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { username: "zenulalabsbot" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
    }

    async function createLink(): Promise<{ token: string; link: string }> {
      const res = await SELF.fetch("https://example.com/bot/connect", { method: "POST", headers: H });
      expect(res.status).toBe(200);
      return (await res.json()) as { token: string; link: string };
    }

    async function postStartUpdate(token: string | null, chatId: number, username?: string) {
      const text = token === null ? "/start" : `/start ${token}`;
      return SELF.fetch(`https://example.com/telegram/webhook/${env.INTERNAL_TOKEN}`, {
        method: "POST",
        body: JSON.stringify({ message: { text, chat: { id: chatId, username } } }),
      });
    }

    it("connect start creates pending link and returns t.me deep link", async () => {
      const spy = telegramMock();
      try {
        const { token, link } = await createLink();
        expect(token).toHaveLength(32);
        expect(link).toBe(`https://t.me/zenulalabsbot?start=${token}`);
        const row = await env.DB.prepare(`SELECT status FROM bot_links WHERE token = ?`).bind(token).first<{ status: string }>();
        expect(row!.status).toBe("pending");
        const status = await SELF.fetch(`https://example.com/bot/status/${token}`, { headers: H });
        expect(((await status.json()) as { status: string }).status).toBe("pending");
      } finally {
        spy.mockRestore();
      }
    });

    it("START with token links chat, saves config chat id, confirms in chat", async () => {
      const spy = telegramMock();
      try {
        await env.DB.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
          VALUES ('owner', '[]', '[]', '[]', '{}', 70, 1, 1, 0, NULL, 1)`).run();
        const { token } = await createLink();
        const res = await postStartUpdate(token, 4242, "harsh");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });

        const row = await env.DB.prepare(`SELECT status, chat_id, telegram_username FROM bot_links WHERE token = ?`).bind(token)
          .first<{ status: string; chat_id: string; telegram_username: string }>();
        expect(row!.status).toBe("linked");
        expect(row!.chat_id).toBe("4242");
        expect(row!.telegram_username).toBe("harsh");

        const cfg = await env.DB.prepare(`SELECT telegram_chat_id FROM configs WHERE user_id='owner'`).first<{ telegram_chat_id: string }>();
        expect(cfg!.telegram_chat_id).toBe("4242");

        // confirmation message was attempted (sendMessage called)
        const calls = (spy.mock.calls as unknown as [string][]).map(([u]) => String(u));
        expect(calls.some((u) => u.includes("/sendMessage"))).toBe(true);

        const status = await SELF.fetch(`https://example.com/bot/status/${token}`, { headers: H });
        const body = (await status.json()) as { status: string; chat_id: string; telegram_username: string };
        expect(body.status).toBe("linked");
        expect(body.chat_id).toBe("4242");
      } finally {
        spy.mockRestore();
      }
    });

    it("plain START (no token) gets a guide message, nothing linked", async () => {
      const spy = telegramMock();
      try {
        await env.DB.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
          VALUES ('owner', '[]', '[]', '[]', '{}', 70, 1, 1, 0, NULL, 1)`).run();
        const res = await postStartUpdate(null, 4242);
        expect(res.status).toBe(200);
        const cfg = await env.DB.prepare(`SELECT telegram_chat_id FROM configs WHERE user_id='owner'`).first<{ telegram_chat_id: string | null }>();
        expect(cfg!.telegram_chat_id).toBeNull();
        const calls = (spy.mock.calls as unknown as [string][]).map(([u]) => String(u));
        expect(calls.some((u) => u.includes("/sendMessage"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("expired token gets retry message, nothing linked", async () => {
      const spy = telegramMock();
      try {
        await env.DB.prepare(`INSERT INTO bot_links (token, user_id, status, created_at) VALUES ('deadbeef', 'owner', 'pending', ?)`)
          .bind(Date.now() - 20 * 60 * 1000).run();
        const res = await postStartUpdate("deadbeef", 4242);
        expect(res.status).toBe(200);
        const row = await env.DB.prepare(`SELECT status FROM bot_links WHERE token = 'deadbeef'`).first<{ status: string }>();
        expect(row!.status).toBe("pending");
      } finally {
        spy.mockRestore();
      }
    });

    it("used token cannot link twice", async () => {
      const spy = telegramMock();
      try {
        await env.DB.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
          VALUES ('owner', '[]', '[]', '[]', '{}', 70, 1, 1, 0, NULL, 1)`).run();
        const { token } = await createLink();
        await postStartUpdate(token, 4242, "harsh");
        const cfg = await env.DB.prepare(`SELECT telegram_chat_id FROM configs WHERE user_id='owner'`).first<{ telegram_chat_id: string }>();
        expect(cfg!.telegram_chat_id).toBe("4242");
        // second attempt with same token from another chat — rejected (already linked)
        await postStartUpdate(token, 9999, "intruder");
        const cfgAfter = await env.DB.prepare(`SELECT telegram_chat_id FROM configs WHERE user_id='owner'`).first<{ telegram_chat_id: string }>();
        expect(cfgAfter!.telegram_chat_id).toBe("4242");
      } finally {
        spy.mockRestore();
      }
    });

    it("webhook rejects unknown secret path", async () => {
      const res = await SELF.fetch("https://example.com/telegram/webhook/wrong-secret", {
        method: "POST",
        body: JSON.stringify({ message: { text: "/start x", chat: { id: 1 } } }),
      });
      expect(res.status).toBe(401);
    });

    it("bot/connect and bot/status require internal token", async () => {
      const connect = await SELF.fetch("https://example.com/bot/connect", { method: "POST" });
      expect(connect.status).toBe(401);
      const status = await SELF.fetch("https://example.com/bot/status/abc");
      expect(status.status).toBe(401);
    });
  });

  it("run-batch validates body shape", async () => {
    const res = await SELF.fetch("https://example.com/run-batch", { method: "POST", headers: H, body: JSON.stringify({ specs: [] }) });
    expect(res.status).toBe(400);
  });

  it("run-batch runs a pipeline slice and returns batch stats", async () => {
    await env.DB.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
      VALUES ('owner', '["Frontend"]', '["React"]', '[]', '{}', 70, 1, 1, 0, '12345', 1)`).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("remotive")) {
        return new Response(JSON.stringify({
          jobs: [{ url: "https://x.co/1", title: "React Dev", company_name: "Acme", candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      const config = { userId: "owner", fields: ["Frontend"], skills: ["React"], sites: [], filters: {}, scoreThreshold: 70, cadenceHours: 1, isActive: true };
      const res = await SELF.fetch("https://example.com/run-batch", {
        method: "POST", headers: H,
        body: JSON.stringify({ specs: [{ type: "remotive" }], runId: "r1", config, chatId: "12345" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; jobsFound: number; sourcesOk: number };
      expect(body.status).toBe("ok");
      expect(body.sourcesOk).toBe(1);
      expect(body.jobsFound).toBeGreaterThanOrEqual(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("set + get config round-trips", async () => {
    const cfg = { userId: "owner", fields: ["Frontend"], skills: ["React"], sites: [{ type: "remotive" }], filters: {}, scoreThreshold: 70, cadenceHours: 1, isActive: true, telegramChatId: "4242" };
    const set = await SELF.fetch("https://example.com/config", { method: "POST", headers: H, body: JSON.stringify(cfg) });
    expect(set.status).toBe(200);
    const get = await SELF.fetch("https://example.com/config", { headers: H });
    const body = await get.json() as Record<string, unknown>;
    expect(body.fields).toEqual(["Frontend"]);
    expect(body.telegramChatId).toBe("4242");
  });

  it("runs endpoint returns list", async () => {
    const res = await SELF.fetch("https://example.com/runs?limit=5", { headers: H });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("scheduled bumps next_run_at", async () => {
    await env.DB.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
      VALUES ('owner', '[]', '[]', '[]', '{}', 70, 2, 1, 0, '1', 1)`).run();
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledEvent, env, ctx);
    const row = await env.DB.prepare(`SELECT next_run_at FROM configs WHERE user_id='owner'`).first<{ next_run_at: number }>();
    expect(row!.next_run_at).toBeGreaterThan(0);
  });

  it("telegram-test rejects without internal token", async () => {
    const res = await SELF.fetch("https://example.com/telegram-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "12345" }),
    });
    expect(res.status).toBe(401);
  });

  it("telegram-test sends a message via the bot api", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    try {
      const res = await SELF.fetch("https://example.com/telegram-test", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ chatId: "12345" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("api.telegram.org/bottest/sendMessage");
      expect(String(init.body)).toContain('"chat_id":"12345"');
      expect(String(init.body)).toContain("connected");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("telegram-test surfaces bot api errors", async () => {
    // Telegram returns HTTP 400 + {ok:false,description} for bad chat ids.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 })
    );
    try {
      const res = await SELF.fetch("https://example.com/telegram-test", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ chatId: "999" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("Telegram error");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
