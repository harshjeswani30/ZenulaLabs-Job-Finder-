import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runUser, runPipeline } from "../src/lib/runUser";
import type { UserConfig } from "@jobfinder/shared";

const db = env.DB;

const TEST_ENV = {
  GROQ_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test",
  INTERNAL_TOKEN: env.INTERNAL_TOKEN, SELF_URL: "https://self.example",
};

const BASE_CONFIG: UserConfig = {
  userId: "owner", fields: ["Frontend"], skills: ["React"], sites: [{ type: "remotive" }],
  filters: {}, scoreThreshold: 70, cadenceHours: 1, isActive: true,
};

/** Mock fetch for everything the pipeline touches in-process:
 *  remotive source, greenhouse/lever/sr board shapes, Groq scoring (85), Telegram. */
function pipelineFetch() {
  return vi.fn().mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("remotive")) {
      return Promise.resolve(new Response(JSON.stringify({
        jobs: [{ url: "https://x.co/1", title: "React Dev", company_name: "Acme", candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>" }],
      }), { status: 200 }));
    }
    if (u.includes("boards-api.greenhouse.io")) {
      return Promise.resolve(new Response(JSON.stringify({
        jobs: [{ title: "React Dev", absolute_url: "https://x.co/gh", location: { name: "Remote" }, updated_at: "2026-09-01T10:00:00Z", content: "" }],
      }), { status: 200 }));
    }
    if (u.includes("api.lever.co")) {
      return Promise.resolve(new Response(JSON.stringify([
        { text: "React Dev", hostedUrl: "https://x.co/lv", categories: { location: "Remote" }, createdAt: 1725148800000, descriptionPlain: "Great" },
      ]), { status: 200 }));
    }
    if (u.includes("api.smartrecruiters.com")) {
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ id: "1", name: "React Dev", releasedDate: "2026-09-01T10:00:00Z", location: { fullLocation: "Remote" } }],
      }), { status: 200 }));
    }
    if (u.includes("groq.com")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const wanted = JSON.parse(body.messages?.[1]?.content ?? "{}") as { jobs: { hash: string }[] };
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(wanted.jobs.map((j: { hash: string }) => ({ hash: j.hash, score: 85 }))) } }],
      }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await db.exec(`DELETE FROM configs; DELETE FROM jobs; DELETE FROM user_jobs; DELETE FROM runs;`);
  await db.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
    VALUES ('owner', '["Frontend"]', '["React"]', '[{"type":"remotive"}]', '{}', 70, 1, 1, 0, '12345', 1)`).run();
});

describe("runUser (orchestrator)", () => {
  it("runs a single explicit source and aggregates stats", async () => {
    const fetchFn = pipelineFetch();
    const result = await runUser({ db, env: TEST_ENV, fetchFn });
    expect(result.status).toBe("ok");
    expect(result.jobsSent).toBeGreaterThanOrEqual(1);
    const sent = await db.prepare(`SELECT COUNT(*) n FROM user_jobs WHERE sent_at IS NOT NULL`).first<{ n: number }>();
    expect(sent!.n).toBeGreaterThanOrEqual(1);
    const runs = await db.prepare(`SELECT status, jobs_sent FROM runs`).first<{ status: string; jobs_sent: number }>();
    expect(runs!.status).toBe("ok");
    expect(runs!.jobs_sent).toBeGreaterThanOrEqual(1);
  });

  it("second run does not resend the same job", async () => {
    const fetchFn = pipelineFetch();
    await runUser({ db, env: TEST_ENV, fetchFn });
    const second = await runUser({ db, env: TEST_ENV, fetchFn });
    expect(second.jobsSent).toBe(0);
  });

  it("marks failed when no config", async () => {
    await db.exec(`DELETE FROM configs`);
    const result = await runUser({ db, env: TEST_ENV, fetchFn: pipelineFetch() });
    expect(result.status).toBe("failed");
  });

  it("a batch pipeline throwing → run still records other batches (in-process fan-out)", async () => {
    // every fetch fails → every source fails, but runPipeline catches per-source
    // errors, so batches are "handled"; a fully dead network yields ok/partial, not failed.
    const fetchFn = vi.fn().mockResolvedValue(new Response("err", { status: 500 })) as unknown as typeof fetch;
    const result = await runUser({ db, env: TEST_ENV, fetchFn });
    expect(result.status).not.toBe("failed");
  });

  it("rotateBoards clamps to the 25-spec free-plan subrequest budget", async () => {
    await db.prepare(`UPDATE configs SET filters = ? WHERE user_id = 'owner'`).bind(
      JSON.stringify({ rotateBoards: { enabled: true, count: 100 } })
    ).run();
    const fetchFn = pipelineFetch();
    const result = await runUser({ db, env: TEST_ENV, fetchFn });
    expect(result.status).toBe("ok");
    const allSpecs = fetchFn.mock.calls.map((c) => String(c[0])).filter((u) =>
      u.includes("remotive.com") || u.includes("boards-api.greenhouse.io") || u.includes("api.lever.co") || u.includes("api.smartrecruiters.com"));
    // 25 total even though the user asked for 100: 1 explicit + 24 rotating
    expect(allSpecs.filter((u) => u.includes("remotive.com"))).toHaveLength(1);
    expect(allSpecs).toHaveLength(25);
    // 24-mix: GH ceil(24*.4)=10 / SR 10 / Lever 4
    expect(allSpecs.filter((u) => u.includes("boards-api.greenhouse.io"))).toHaveLength(10);
    expect(allSpecs.filter((u) => u.includes("api.smartrecruiters.com"))).toHaveLength(10);
    expect(allSpecs.filter((u) => u.includes("api.lever.co"))).toHaveLength(4);
    const runs = await db.prepare(`SELECT status FROM runs`).first<{ status: string }>();
    expect(runs!.status).toBe("ok");
  });
});

describe("runPipeline (batch core)", () => {
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
      if (u.includes("groq.com")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const wanted = JSON.parse(body.messages?.[1]?.content ?? "{}") as { jobs: { hash: string }[] };
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(wanted.jobs.map((j: { hash: string }) => ({ hash: j.hash, score: 85 }))) } }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await runPipeline({ db, env: TEST_ENV, fetchFn }, BASE_CONFIG.sites, BASE_CONFIG, "12345");
    expect(result.status).toBe("ok");
    expect(result.jobsSent).toBe(25); // all 25 scored 85 ≥ 70, chunkForSending caps at 30 → all sent
    const scored = await db.prepare(`SELECT COUNT(*) n FROM user_jobs WHERE score = 85`).first<{ n: number }>();
    expect(scored!.n).toBe(25);
  });

  it("deferred (cap-overflow) unseen jobs get scored on the next run", async () => {
    // Regression: the old unseen query filtered first_seen_at = <run's now>,
    // so any job not scored in its own run was silently lost forever.
    const jobsFetch = (n: number) => vi.fn().mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("remotive")) {
        const jobs = Array.from({ length: n }, (_, i) => ({
          url: `https://x.co/${i}`, title: `React Dev ${i}`, company_name: "Acme",
          candidate_required_location: "Remote", salary: "", publication_date: "2026-09-01T10:00:00Z", description: "<p>Great</p>",
        }));
        return Promise.resolve(new Response(JSON.stringify({ jobs }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof fetch;

    // run 1: both jobs scored (keyword fallback "react" hit → 75 ≥ 70) and sent
    await runPipeline({ db, env: TEST_ENV, fetchFn: jobsFetch(2) }, [{ type: "remotive" }], BASE_CONFIG, "12345");

    // simulate a cap-overflow: one scored job's user_jobs row vanishes → it is "unseen" again
    await db.prepare(`DELETE FROM user_jobs WHERE job_hash = (SELECT job_hash FROM user_jobs LIMIT 1)`).run();
    const before = await db.prepare(`SELECT COUNT(*) n FROM user_jobs WHERE sent_at IS NOT NULL`).first<{ n: number }>();

    // run 2: deferred job must now be re-scored and sent (no first_seen_at time filter dropping it)
    await runPipeline({ db, env: TEST_ENV, fetchFn: jobsFetch(2) }, [{ type: "remotive" }], BASE_CONFIG, "12345");
    const after = await db.prepare(`SELECT COUNT(*) n FROM user_jobs WHERE sent_at IS NOT NULL`).first<{ n: number }>();
    expect(after!.n).toBeGreaterThan(before!.n);
  });

  it("source failure marks batch partial, not failed", async () => {
    const badSource = vi.fn().mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("remotive")) return Promise.resolve(new Response("err", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await runPipeline({ db, env: TEST_ENV, fetchFn: badSource }, [{ type: "remotive" }], BASE_CONFIG, "12345");
    expect(result.status).toBe("partial");
    expect(result.sourcesFailed).toBe(1);
    expect(result.jobsFound).toBe(0);
  });

  it("zero specs → ok with zero everything", async () => {
    const result = await runPipeline({ db, env: TEST_ENV, fetchFn: pipelineFetch() }, [], BASE_CONFIG, "12345");
    expect(result.status).toBe("ok");
    expect(result.jobsFound).toBe(0);
  });
});
