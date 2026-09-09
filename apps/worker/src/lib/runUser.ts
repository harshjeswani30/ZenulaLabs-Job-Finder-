import type { JobSourceSpec, NormalizedJob, ScoredJob, UserConfig } from "@jobfinder/shared";
import { getSourceParser } from "../sources/registry";
import { scoreJobs } from "./scorer";
import { chunkForSending, formatJobMessage, sendTelegramMessage } from "./telegram";
import { defaultRotationSpecs } from "./companyRotation";

export interface RunUserDeps {
  db: D1Database;
  env: { GROQ_API_KEY: string; TELEGRAM_BOT_TOKEN: string; INTERNAL_TOKEN: string; SELF_URL: string };
  fetchFn?: typeof fetch;
  maxSources?: number;
  userId?: string; // defaults to the legacy single-user row
}

export interface RunUserResult { status: "ok" | "partial" | "failed"; jobsSent: number; error?: string; }

/** One fan-out batch of source specs: fetched → deduped → stored → scored → sent. */
export interface BatchResult {
  status: "ok" | "partial" | "failed";
  sourcesOk: number;
  sourcesFailed: number;
  jobsFound: number;
  jobsSent: number;
  deferredScored: number; // unseen jobs left for the next run (scored cap overflow)
  error?: string;
}

const BATCH_SIZE = 10;          // source specs per /run-batch invocation (50-subrequest budget)
const MAX_SCORED_PER_BATCH = 300; // 25-job Groq chunks → ≤12 scoring calls per batch

interface ConfigRow extends Record<string, string | number | null> { telegram_chat_id: string | null }

function loadConfig(cfgRow: ConfigRow, userId: string): UserConfig {
  return {
    userId,
    fields: JSON.parse(String(cfgRow.fields)) as string[],
    skills: JSON.parse(String(cfgRow.skills)) as string[],
    sites: JSON.parse(String(cfgRow.sites)),
    filters: JSON.parse(String(cfgRow.filters)),
    scoreThreshold: Number(cfgRow.score_threshold),
    cadenceHours: Number(cfgRow.cadence_hours),
    isActive: true,
  };
}

/** Core pipeline for a batch of source specs. No runs-row write — the orchestrator owns that. */
export async function runPipeline(
  deps: RunUserDeps,
  specs: JobSourceSpec[],
  config: UserConfig,
  chatId: string
): Promise<BatchResult> {
  const fetchFn = deps.fetchFn ?? fetch;
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
  if (jobs.length === 0) {
    return { status: sourcesFailed > 0 ? "partial" : "ok", sourcesOk, sourcesFailed, jobsFound: 0, jobsSent: 0, deferredScored: 0 };
  }

  // D1 caps bound parameters per statement at 100 — chunk multi-row inserts below it.
  const jobsPerStmt = Math.floor(90 / 10); // 10 columns → 9 rows (90 params)
  const stmts = [];
  const now = Date.now();
  for (let i = 0; i < jobs.length; i += jobsPerStmt) {
    const chunk = jobs.slice(i, i + jobsPerStmt);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const binds = chunk.flatMap((j) => [j.hash, j.title, j.company, j.location, j.salary, j.url, j.source, j.descriptionSnippet, j.postedAt, now]);
    stmts.push(deps.db.prepare(`INSERT OR IGNORE INTO jobs (hash, title, company, location, salary, url, source, description_snippet, posted_at, first_seen_at) VALUES ${values}`).bind(...binds));
  }
  await deps.db.batch(stmts);

  // unseen = stored job this user has never seen — no time filter, so jobs that
  // overflowed a previous run's scored cap get picked up here instead of being lost.
  const unseen = await deps.db.prepare(
    `SELECT j.hash FROM jobs j LEFT JOIN user_jobs uj ON uj.job_hash = j.hash AND uj.user_id = ?
     WHERE uj.job_hash IS NULL`
  ).bind(config.userId).all<{ hash: string }>();
  const unseenHashes = new Set(unseen.results.map((r) => r.hash));
  const unseenJobs = jobs.filter((j) => unseenHashes.has(j.hash));
  if (unseenJobs.length === 0) {
    return { status: sourcesFailed > 0 ? "partial" : "ok", sourcesOk, sourcesFailed, jobsFound: jobs.length, jobsSent: 0, deferredScored: 0 };
  }

  // cap scoring per batch; overflow stays unseen and is scored on the next run
  const toScore = unseenJobs.slice(0, MAX_SCORED_PER_BATCH);
  const deferredScored = unseenJobs.length - toScore.length;

  const scored = await scoreJobs(deps.env.GROQ_API_KEY, config, toScore, fetchFn);
  const matches: ScoredJob[] = scored.filter((s) => s.score >= config.scoreThreshold).sort((a, b) => b.score - a.score);

  // record all scored jobs (sent_at null unless sent)
  const userJobsPerStmt = Math.floor(90 / 5); // 5 columns → 18 rows (90 params)
  const insStmts = [];
  for (let i = 0; i < scored.length; i += userJobsPerStmt) {
    const chunk = scored.slice(i, i + userJobsPerStmt);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const binds = chunk.flatMap((s) => [config.userId, s.job.hash, now, null, s.score]);
    insStmts.push(deps.db.prepare(`INSERT INTO user_jobs (user_id, job_hash, first_seen_at, sent_at, score) VALUES ${values}`).bind(...binds));
  }
  if (insStmts.length) await deps.db.batch(insStmts);

  let sent = 0;
  if (matches.length > 0) {
    const chunks = chunkForSending(matches);
    try {
      for (const c of chunks) {
        const header = `🔥 ${matches.length} new job${matches.length === 1 ? "" : "s"} — ${config.fields.join("/") || "your fields"}`;
        await sendTelegramMessage(deps.env.TELEGRAM_BOT_TOKEN, chatId, formatJobMessage(header, c.jobs), fetchFn);
        sent += c.jobs.length;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "partial", sourcesOk, sourcesFailed, jobsFound: jobs.length, jobsSent: sent, deferredScored, error: message };
    }
    await deps.db.prepare(`UPDATE user_jobs SET sent_at = ? WHERE user_id = ? AND sent_at IS NULL AND score >= ?`)
      .bind(now, config.userId, config.scoreThreshold).run();
  }

  const status = sourcesFailed > 0 ? "partial" : "ok";
  return { status, sourcesOk, sourcesFailed, jobsFound: jobs.length, jobsSent: sent, deferredScored };
}

export async function runUser(deps: RunUserDeps): Promise<RunUserResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const started = Date.now();
  const runId = crypto.randomUUID();
  const userId = deps.userId ?? "owner";

  const cfgRow = await deps.db.prepare(`SELECT * FROM configs WHERE user_id = ?`).bind(userId).first<ConfigRow>();
  if (!cfgRow || Number(cfgRow.is_active) !== 1 || !cfgRow.telegram_chat_id) {
    return { status: "failed", jobsSent: 0, error: "no config/chat_id" };
  }
  const config = loadConfig(cfgRow, userId);
  const chatId = String(cfgRow.telegram_chat_id);

  const cap = deps.maxSources ?? 100;
  // Explicit user sites first; rotateBoards (via config.filters) appends a rotating
  // slice of the 1205-company catalog up to the cap. Default 100 companies/run.
  const filters = config.filters as { rotateBoards?: { enabled?: boolean; count?: number } };
  const explicitSpecs = config.sites.slice(0, cap);
  let specs = explicitSpecs;
  if (filters?.rotateBoards?.enabled) {
    const rotCount = Math.min(filters.rotateBoards.count ?? 100, cap - explicitSpecs.length);
    if (rotCount > 0) specs = [...explicitSpecs, ...defaultRotationSpecs(rotCount)];
  }
  if (specs.length === 0) {
    await insertRun(deps.db, runId, userId, started, "ok", 0, 0, 0, 0, undefined);
    return { status: "ok", jobsSent: 0 };
  }

  // Fan out in parallel batches — each /run-batch invocation gets its own
  // subrequest budget (free plan caps a single invocation at 50 fetches).
  const batches: JobSourceSpec[][] = [];
  for (let i = 0; i < specs.length; i += BATCH_SIZE) batches.push(specs.slice(i, i + BATCH_SIZE));

  const results = await Promise.allSettled(batches.map((batchSpecs) =>
    fetchFn(`${deps.env.SELF_URL}/run-batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": deps.env.INTERNAL_TOKEN },
      body: JSON.stringify({ specs: batchSpecs, runId, config: { ...config, isActive: true }, chatId }),
    })
  ));

  let sourcesOk = 0, sourcesFailed = 0, jobsFound = 0, jobsSent = 0, deferredScored = 0;
  let anyPartial = false;
  const errors: string[] = [];
  let handled = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") { anyPartial = true; continue; }
    const body = await r.value.json().catch(() => null) as BatchResult | null;
    if (!body || typeof body.sourcesOk !== "number") { anyPartial = true; continue; }
    handled++;
    sourcesOk += body.sourcesOk;
    sourcesFailed += body.sourcesFailed;
    jobsFound += body.jobsFound;
    jobsSent += body.jobsSent;
    deferredScored += body.deferredScored ?? 0;
    if (body.status !== "ok") anyPartial = true;
    if (body.error) errors.push(body.error);
  }
  if (handled < batches.length) anyPartial = true;
  if (handled === 0) {
    const error = errors[0] ?? "all batches failed";
    await insertRun(deps.db, runId, userId, started, "failed", 0, 0, jobsFound, 0, error);
    return { status: "failed", jobsSent: 0, error };
  }

  const status = anyPartial ? "partial" : "ok";
  await insertRun(deps.db, runId, userId, started, status, sourcesOk, sourcesFailed, jobsFound, jobsSent, errors[0]);
  return { status, jobsSent };
}

async function insertRun(db: D1Database, id: string, userId: string, startedAt: number, status: string, ok: number, failed: number, found: number, sent: number, error: string | undefined) {
  await db.prepare(
    `INSERT INTO runs (id, user_id, started_at, status, sources_ok, sources_failed, jobs_found, jobs_sent, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, startedAt, status, ok, failed, found, sent, error ?? null, Date.now() - startedAt).run();
}
