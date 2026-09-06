import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runUser } from "../src/lib/runUser";

const db = env.DB;

const telegramOk = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

function sourceFetch(job: Record<string, string>) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    jobs: [{ url: job.url, title: job.title, company_name: job.company, candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>" }],
  }), { status: 200 })) as unknown as typeof fetch;
}

beforeEach(async () => {
  await db.exec(`DELETE FROM configs; DELETE FROM jobs; DELETE FROM user_jobs; DELETE FROM runs;`);
  await db.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
    VALUES ('owner', '["Frontend"]', '["React"]', '[{"type":"remotive"}]', '{}', 70, 1, 1, 0, '12345', 1)`).run();
});

describe("runUser", () => {
  it("end-to-end: sources→dedupe→score→telegram→runs row", async () => {
    const fetchFn = sourceFetch({ url: "https://x.co/1", title: "React Dev", company: "Acme" });
    const result = await runUser({ db, env: { ANTHROPIC_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    expect(result.status).toBe("ok");
    expect(result.jobsSent).toBeGreaterThanOrEqual(1);
    const sent = await db.prepare(`SELECT COUNT(*) n FROM user_jobs WHERE sent_at IS NOT NULL`).first<{ n: number }>();
    expect(sent!.n).toBeGreaterThanOrEqual(1);
    const runs = await db.prepare(`SELECT status, jobs_sent FROM runs`).first<{ status: string; jobs_sent: number }>();
    expect(runs!.status).toBe("ok");
    expect(runs!.jobs_sent).toBeGreaterThanOrEqual(1);
  });

  it("second run does not resend the same job", async () => {
    const fetchFn = sourceFetch({ url: "https://x.co/1", title: "React Dev", company: "Acme" });
    await runUser({ db, env: { ANTHROPIC_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    const second = await runUser({ db, env: { ANTHROPIC_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    expect(second.jobsSent).toBe(0);
  });

  it("marks failed when no config", async () => {
    await db.exec(`DELETE FROM configs`);
    const result = await runUser({ db, env: { ANTHROPIC_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn: telegramOk });
    expect(result.status).toBe("failed");
  });

  it("marks partial when source fails but telegram still works via fallback", async () => {
    const badSource = vi.fn().mockResolvedValue(new Response("err", { status: 500 })) as unknown as typeof fetch;
    const result = await runUser({ db, env: { ANTHROPIC_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn: badSource });
    expect(result.status).toBe("partial");
  });
});
