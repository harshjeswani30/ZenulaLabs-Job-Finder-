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
    const result = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
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
    await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    const second = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    expect(second.jobsSent).toBe(0);
  });

  it("marks failed when no config", async () => {
    await db.exec(`DELETE FROM configs`);
    const result = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn: telegramOk });
    expect(result.status).toBe("failed");
  });

  it("marks partial when source fails but telegram still works via fallback", async () => {
    const badSource = vi.fn().mockResolvedValue(new Response("err", { status: 500 })) as unknown as typeof fetch;
    const result = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn: badSource });
    expect(result.status).toBe("partial");
  });

  it("handles >9 jobs without hitting D1's 100-bind limit", async () => {
    // Regression: bulk inserts used 40-row chunks (10 cols × 40 = 400 binds) — D1 caps at 100.
    // 25 unique jobs force both the jobs insert (10 binds/row) and user_jobs insert (5 binds/row) to chunk.
    const fetchFn = vi.fn().mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("remotive")) {
        const jobs = Array.from({ length: 25 }, (_, i) => ({
          url: `https://x.co/${i}`, title: `React Dev ${i}`, company_name: "Acme",
          candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>",
        }));
        return Promise.resolve(new Response(JSON.stringify({ jobs }), { status: 200 }));
      }
      // LLM scoring call (Groq/OpenAI-compatible) — body arrives in the RequestInit (second arg)
      if (u.includes("groq.com") || u.includes("anthropic")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const wanted = JSON.parse(body.messages?.[1]?.content ?? "{}") as { jobs: { hash: string }[] };
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(wanted.jobs.map((j: { hash: string }) => ({ hash: j.hash, score: 85 }))) } }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    expect(result.status).toBe("ok");
    expect(result.jobsSent).toBe(25); // all 25 scored 85 ≥ 70, chunkForSending caps at 30 → all sent
    const scored = await db.prepare(`SELECT COUNT(*) n FROM user_jobs WHERE score = 85`).first<{ n: number }>();
    expect(scored!.n).toBe(25);
  });

  it("rotateBoards appends rotating company specs to explicit sites", async () => {
    await db.prepare(`UPDATE configs SET filters = ? WHERE user_id = 'owner'`).bind(
      JSON.stringify({ rotateBoards: { enabled: true, count: 6 } })
    ).run();
    const seen: string[] = [];
    const fetchFn = vi.fn().mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      // Each parser gets a body it can actually parse (greenhouse/lever/sr board shapes).
      const gh = { jobs: [{ title: "React Dev", absolute_url: "https://x.co/1", location: { name: "Remote" }, updated_at: "2026-09-01T10:00:00Z", content: "" }] };
      const lv = [{ text: "React Dev", hostedUrl: "https://x.co/2", categories: { location: "Remote" }, createdAt: 1725148800000, descriptionPlain: "Great" }];
      const sr = { content: [{ id: "1", name: "React Dev", releasedDate: "2026-09-01T10:00:00Z", location: { fullLocation: "Remote" } }] };
      const rem = { jobs: [{ url: "https://x.co/3", title: "React Dev", company_name: "Acme", candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>" }] };
      let body: unknown;
      if (u.includes("greenhouse")) body = gh;
      else if (u.includes("lever.co")) body = lv;
      else if (u.includes("smartrecruiters")) body = sr;
      else if (u.includes("remotive")) body = rem;
      else body = { ok: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    expect(result.status).toBe("ok");
    // 1 explicit remotive + 6 rotating boards (new 40/40/20 mix: 3 gh + 3 sr + 0 lever)
    const boardCalls = seen.filter((u) => u.includes("boards-api.greenhouse.io") || u.includes("api.lever.co") || u.includes("api.smartrecruiters.com"));
    expect(boardCalls).toHaveLength(6);
    expect(seen.filter((u) => u.includes("remotive.com"))).toHaveLength(1);
  });

  it("rotateBoards count 20 → GH 8 / SR 8 / Lever 3 (cap leaves 19 slots after explicit remotive)", async () => {
    await db.prepare(`UPDATE configs SET filters = ? WHERE user_id = 'owner'`).bind(
      JSON.stringify({ rotateBoards: { enabled: true, count: 20 } })
    ).run();
    const seen: string[] = [];
    const fetchFn = vi.fn().mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      const gh = { jobs: [{ title: "React Dev", absolute_url: "https://x.co/1", location: { name: "Remote" }, updated_at: "2026-09-01T10:00:00Z", content: "" }] };
      const lv = [{ text: "React Dev", hostedUrl: "https://x.co/2", categories: { location: "Remote" }, createdAt: 1725148800000, descriptionPlain: "Great" }];
      const sr = { content: [{ id: "1", name: "React Dev", releasedDate: "2026-09-01T10:00:00Z", location: { fullLocation: "Remote" } }] };
      const rem = { jobs: [{ url: "https://x.co/3", title: "React Dev", company_name: "Acme", candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>" }] };
      let body: unknown;
      if (u.includes("greenhouse")) body = gh;
      else if (u.includes("lever.co")) body = lv;
      else if (u.includes("smartrecruiters")) body = sr;
      else if (u.includes("remotive")) body = rem;
      else body = { ok: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn });
    expect(result.status).toBe("ok");
    expect(seen.filter((u) => u.includes("boards-api.greenhouse.io"))).toHaveLength(8);
    expect(seen.filter((u) => u.includes("api.smartrecruiters.com"))).toHaveLength(8);
    expect(seen.filter((u) => u.includes("api.lever.co"))).toHaveLength(3);
  });

  it("rotateBoards respects MAX_SOURCES_PER_RUN cap (explicit + rotation ≤ 20)", async () => {
    await db.prepare(`UPDATE configs SET filters = ? WHERE user_id = 'owner'`).bind(
      JSON.stringify({ rotateBoards: { enabled: true, count: 20 } })
    ).run();
    const seen: string[] = [];
    const fetchFn = vi.fn().mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      const gh = { jobs: [] };
      const lv: unknown[] = [];
      const sr = { content: [] };
      const rem = { jobs: [] };
      let body: unknown;
      if (u.includes("greenhouse")) body = gh;
      else if (u.includes("lever.co")) body = lv;
      else if (u.includes("smartrecruiters")) body = sr;
      else if (u.includes("remotive")) body = rem;
      else body = { ok: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    // maxSources 20: 1 explicit remotive + 19 rotating
    await runUser({ db, env: { GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }, fetchFn, maxSources: 20 });
    const boardCalls = seen.filter((u) => u.includes("boards-api.greenhouse.io") || u.includes("api.lever.co") || u.includes("api.smartrecruiters.com"));
    expect(boardCalls).toHaveLength(19);
    expect(seen.filter((u) => u.includes("remotive.com"))).toHaveLength(1);
  });

});
