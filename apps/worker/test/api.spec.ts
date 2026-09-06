import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";

const H = { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" };

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM configs; DELETE FROM jobs; DELETE FROM user_jobs; DELETE FROM runs;`);
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
