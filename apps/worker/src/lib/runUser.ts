import type { NormalizedJob, ScoredJob, UserConfig } from "@jobfinder/shared";
import { getSourceParser } from "../sources/registry";
import { scoreJobs } from "./scorer";
import { chunkForSending, formatJobMessage, sendTelegramMessage } from "./telegram";
import { defaultRotationSpecs } from "./companyRotation";

export interface RunUserDeps {
  db: D1Database;
  env: { GROQ_API_KEY: string; TELEGRAM_BOT_TOKEN: string };
  fetchFn?: typeof fetch;
  maxSources?: number;
}

export interface RunUserResult { status: "ok" | "partial" | "failed"; jobsSent: number; error?: string; }

const USER_ID = "owner"; // MVP single user; Task 10 parameterizes

export async function runUser(deps: RunUserDeps): Promise<RunUserResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const started = Date.now();
  const runId = crypto.randomUUID();

  const cfgRow = await deps.db.prepare(`SELECT * FROM configs WHERE user_id = ?`).bind(USER_ID).first<Record<string, string | number | null>>();
  if (!cfgRow || Number(cfgRow.is_active) !== 1 || !cfgRow.telegram_chat_id) {
    return { status: "failed", jobsSent: 0, error: "no config/chat_id" };
  }
  const config: UserConfig = {
    userId: USER_ID,
    fields: JSON.parse(String(cfgRow.fields)) as string[],
    skills: JSON.parse(String(cfgRow.skills)) as string[],
    sites: JSON.parse(String(cfgRow.sites)),
    filters: JSON.parse(String(cfgRow.filters)),
    scoreThreshold: Number(cfgRow.score_threshold),
    cadenceHours: Number(cfgRow.cadence_hours),
    isActive: true,
  };

  const now = Date.now();
  const cap = deps.maxSources ?? 20;
  // Explicit user sites first; if rotateBoards is enabled (via config.filters),
  // append a rotating slice of the 1205-company catalog until the cap.
  const filters = config.filters as { rotateBoards?: { enabled?: boolean; count?: number } };
  const explicitSpecs = config.sites.slice(0, cap);
  let specs = explicitSpecs;
  if (filters?.rotateBoards?.enabled) {
    const rotCount = Math.min(filters.rotateBoards.count ?? 6, cap - explicitSpecs.length);
    if (rotCount > 0) specs = [...explicitSpecs, ...defaultRotationSpecs(rotCount)];
  }
  let sourcesOk = 0, sourcesFailed = 0;
  const collected: NormalizedJob[] = [];
  for (let i = 0; i < specs.length; i += 5) {
    const batch = specs.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(async (spec) => {
      const parser = getSourceParser(spec.type);
      return parser(spec, fetchFn);
    }));
    for (const r of results) {
      if (r.status === "fulfilled") { sourcesOk++; collected.push(...r.value); }
      else sourcesFailed++;
    }
  }

  // dedupe within batch
  const unique = new Map<string, NormalizedJob>();
  for (const j of collected) unique.set(j.hash, j);
  const jobs = [...unique.values()];

  if (jobs.length > 0) {
    // D1 caps bound parameters per statement at 100 — chunk multi-row inserts below it.
    const jobsPerStmt = Math.floor(90 / 10); // 10 columns → 9 rows (90 params)
    const stmts = [];
    for (let i = 0; i < jobs.length; i += jobsPerStmt) {
      const chunk = jobs.slice(i, i + jobsPerStmt);
      const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const binds = chunk.flatMap((j) => [j.hash, j.title, j.company, j.location, j.salary, j.url, j.source, j.descriptionSnippet, j.postedAt, now]);
      stmts.push(deps.db.prepare(`INSERT OR IGNORE INTO jobs (hash, title, company, location, salary, url, source, description_snippet, posted_at, first_seen_at) VALUES ${values}`).bind(...binds));
    }
    await deps.db.batch(stmts);

    const unseen = await deps.db.prepare(
      `SELECT j.hash FROM jobs j LEFT JOIN user_jobs uj ON uj.job_hash = j.hash AND uj.user_id = ?
       WHERE uj.job_hash IS NULL AND j.first_seen_at = ?`
    ).bind(USER_ID, now).all<{ hash: string }>();
    const unseenHashes = new Set(unseen.results.map((r) => r.hash));
    const unseenJobs = jobs.filter((j) => unseenHashes.has(j.hash));

    if (unseenJobs.length > 0) {
      const scored = await scoreJobs(deps.env.GROQ_API_KEY, config, unseenJobs, fetchFn);
      const matches: ScoredJob[] = scored.filter((s) => s.score >= config.scoreThreshold).sort((a, b) => b.score - a.score);

      // record all unseen with scores (sent_at null unless sent)
      const userJobsPerStmt = Math.floor(90 / 5); // 5 columns → 18 rows (90 params)
      const insStmts = [];
      for (let i = 0; i < scored.length; i += userJobsPerStmt) {
        const chunk = scored.slice(i, i + userJobsPerStmt);
        const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
        const binds = chunk.flatMap((s) => [USER_ID, s.job.hash, now, null, s.score]);
        insStmts.push(deps.db.prepare(`INSERT INTO user_jobs (user_id, job_hash, first_seen_at, sent_at, score) VALUES ${values}`).bind(...binds));
      }
      if (insStmts.length) await deps.db.batch(insStmts);

      let sent = 0;
      if (matches.length > 0 && config.userId === USER_ID) {
        const chunks = chunkForSending(matches);
        try {
          for (const c of chunks) {
            const header = `🔥 ${matches.length} new job${matches.length === 1 ? "" : "s"} — ${config.fields.join("/") || "your fields"}`;
            await sendTelegramMessage(deps.env.TELEGRAM_BOT_TOKEN, String(cfgRow.telegram_chat_id), formatJobMessage(header, c.jobs), fetchFn);
            sent += c.jobs.length;
          }
        } catch (err) {
          // send failed: mark run partial, record it, do not mark rows sent
          const message = err instanceof Error ? err.message : String(err);
          await insertRun(deps.db, runId, started, "partial", sourcesOk, sourcesFailed, jobs.length, sent, message);
          return { status: "partial", jobsSent: sent, error: message };
        }
        await deps.db.prepare(`UPDATE user_jobs SET sent_at = ? WHERE user_id = ? AND sent_at IS NULL AND score >= ?`)
          .bind(now, USER_ID, config.scoreThreshold).run();
      }
      const status = sourcesFailed > 0 ? "partial" : "ok";
      await insertRun(deps.db, runId, started, status, sourcesOk, sourcesFailed, jobs.length, sent, undefined);
      return { status, jobsSent: sent };
    }
  }

  const status = sourcesFailed > 0 ? "partial" : "ok";
  await insertRun(deps.db, runId, started, status, sourcesOk, sourcesFailed, jobs.length, 0, undefined);
  return { status, jobsSent: 0 };
}

async function insertRun(db: D1Database, id: string, startedAt: number, status: string, ok: number, failed: number, found: number, sent: number, error: string | undefined) {
  await db.prepare(
    `INSERT INTO runs (id, user_id, started_at, status, sources_ok, sources_failed, jobs_found, jobs_sent, error, duration_ms) VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, startedAt, status, ok, failed, found, sent, error ?? null, Date.now() - startedAt).run();
}
