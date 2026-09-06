import { describe, it, expect, beforeEach } from "vitest";
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
});
