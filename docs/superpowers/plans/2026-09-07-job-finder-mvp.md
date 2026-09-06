# Job Finder MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 MVP — a single-user (owner) Telegram job feed: Cloudflare Worker scrapes free job APIs hourly, dedupes, scores relevance with Claude Haiku, and sends matches to Telegram, with a minimal Next.js settings/dashboard UI.

**Architecture:** One Cloudflare Worker holds all logic (cron scheduler → self-fetch fan-out → per-user runner). D1 stores config, jobs (deduped by hash), per-user delivery state, and run logs. Next.js UI on Vercel talks to the Worker over REST with an internal token. Claude API is server-side only.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + wrangler, Vitest (with `@cloudflare/vitest-pool-workers`), Next.js 14 (app router) + Tailwind, Anthropic SDK (Haiku), Telegram Bot API (plain fetch).

**Spec:** `docs/superpowers/specs/2026-09-07-job-finder-design.md` (repo root = `Job Finder` folder on Desktop)

## Global Constraints

- Repo root: `C:\Users\harsh\OneDrive\Desktop\Job Finder` — monorepo with `apps/worker` and `apps/web` + `packages/shared`.
- Package manager: npm. Node ≥ 20. All code TypeScript, strict mode.
- Free-plan limits drive design: ≤ 20 source fetches per run, ≤ 10 D1 writes per user-run, messages batched 5–10 jobs.
- MVP is single-user: config row `user_id='owner'` seeded; no auth. `POST /run-user` guarded by shared-secret header `x-internal-token` (value from env `INTERNAL_TOKEN`).
- All secrets via env/wrangler secrets — NEVER hardcode: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `INTERNAL_TOKEN`, D1 binding `DB`.
- TDD: every task writes failing test first, then implementation, then commit. Vitest for worker logic; source parsers tested against recorded fixtures in `apps/worker/src/sources/__fixtures__/`.
- Scoring threshold default 70; fallback = keyword filter (any user skill case-insensitively present in title+description) on Claude failure.
- Message format per spec §6; ≤ 4 Telegram sends per run (top 30 jobs by score, 8 per message).
- Windows environment: use PowerShell-compatible commands in steps; no `&&` in PowerShell (use `;` or separate steps).
- Commit after every task step that passes tests, with conventional-commit messages.

---

### Task 1: Scaffold monorepo + Worker + D1 schema

**Files:**
- Create: `package.json` (root, npm workspaces)
- Create: `apps/worker/package.json`, `apps/worker/wrangler.jsonc`, `apps/worker/tsconfig.json`, `apps/worker/vitest.config.ts`
- Create: `apps/worker/src/index.ts` (skeleton worker with fetch + scheduled handlers)
- Create: `apps/worker/migrations/0001_init.sql`
- Create: `packages/shared/package.json`, `packages/shared/src/types.ts`
- Test: `apps/worker/test/index.spec.ts`

**Interfaces:**
- Produces: Worker fetch handler responding `{ok:true}` at `GET /health`; scheduled handler stub calling `runDueUsers` (Task 6). Shared types in `packages/shared/src/types.ts`: `JobSource`, `UserConfig`, `NormalizedJob`, `ScoredJob`, `RunRecord` (defined verbatim below).

- [ ] **Step 1: Create folder structure and root package.json**

```json
{
  "name": "job-finder",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "worker": "npm run dev -w apps/worker",
    "web": "npm run dev -w apps/web",
    "test": "npm run test -w apps/worker"
  }
}
```

- [ ] **Step 2: Worker package + wrangler config**

`apps/worker/package.json`:

```json
{
  "name": "@jobfinder/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "db:migrate": "wrangler d1 migrations apply jobfinder-db --local",
    "db:migrate:remote": "wrangler d1 migrations apply jobfinder-db --remote"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.19",
    "@cloudflare/workers-types": "^4.20250903.0",
    "typescript": "^5.6.0",
    "vitest": "^3.2.0",
    "wrangler": "^4.27.0"
  }
}
```

`apps/worker/wrangler.jsonc`:

```jsonc
{
  "name": "jobfinder-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/10 * * * *"] },
  "d1_databases": [
    { "binding": "DB", "database_name": "jobfinder-db", "database_id": "PLACEHOLDER_CREATE_VIA_WRANGLER" }
  ],
  "vars": { "SCORE_THRESHOLD_DEFAULT": "70", "MAX_SOURCES_PER_RUN": "20" }
}
```

Note: `database_id` placeholder — replaced in Task 8 after `wrangler d1 create jobfinder-db`.

`apps/worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        main: "./src/index.ts",
      },
    },
  },
});
```

- [ ] **Step 3: Shared types**

`packages/shared/package.json`:

```json
{
  "name": "@jobfinder/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/types.ts",
  "types": "./src/types.ts"
}
```

`packages/shared/src/types.ts`:

```ts
export interface NormalizedJob {
  hash: string;            // sha256(source|title|company|url)
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  url: string;
  source: string;          // "remotive" | "arbeitnow" | "remoteok" | "greenhouse:<slug>" | "lever:<slug>"
  descriptionSnippet: string; // first 800 chars, whitespace-collapsed
  postedAt: number | null;  // unix ms
}

export interface UserConfig {
  userId: string;
  fields: string[];
  skills: string[];
  sites: JobSourceSpec[];
  filters: { remoteOnly?: boolean; countries?: string[]; keywords?: string[] };
  scoreThreshold: number;
  cadenceHours: number;
  isActive: boolean;
}

export interface JobSourceSpec {
  type: "remotive" | "arbeitnow" | "remoteok" | "greenhouse" | "lever" | "adzuna";
  slug?: string;      // greenhouse/lever company slug
  query?: string;     // adzuna search terms
}

export interface ScoredJob {
  job: NormalizedJob;
  score: number;      // 0-100
  reason?: string;
}

export interface RunRecord {
  id: string;
  userId: string;
  startedAt: number;
  status: "ok" | "partial" | "failed";
  sourcesOk: number;
  sourcesFailed: number;
  jobsFound: number;
  jobsSent: number;
  error?: string;
  durationMs: number;
}
```

- [ ] **Step 4: D1 migration**

`apps/worker/migrations/0001_init.sql`:

```sql
CREATE TABLE configs (
  user_id TEXT PRIMARY KEY,
  fields TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  sites TEXT NOT NULL DEFAULT '[]',
  filters TEXT NOT NULL DEFAULT '{}',
  score_threshold INTEGER NOT NULL DEFAULT 70,
  cadence_hours INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  hash TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  salary TEXT,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  description_snippet TEXT NOT NULL,
  posted_at INTEGER,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE user_jobs (
  user_id TEXT NOT NULL,
  job_hash TEXT NOT NULL REFERENCES jobs(hash),
  first_seen_at INTEGER NOT NULL,
  sent_at INTEGER,
  score INTEGER,
  PRIMARY KEY (user_id, job_hash)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  sources_ok INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  jobs_found INTEGER NOT NULL DEFAULT 0,
  jobs_sent INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX idx_user_jobs_unsent ON user_jobs(user_id, sent_at);
CREATE INDEX idx_configs_due ON configs(is_active, next_run_at);
```

- [ ] **Step 5: Skeleton worker**

`apps/worker/src/index.ts`:

```ts
export default {
  async fetch(_req: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(_req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, _env: Env, ctx: ExecutionContext): Promise<void> {
    // implemented in Task 6 (scheduler)
    ctx.waitUntil(Promise.resolve());
  },
};
```

`apps/worker/src/env.d.ts`:

```ts
export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_TOKEN: string;
  SCORE_THRESHOLD_DEFAULT: string;
  MAX_SOURCES_PER_RUN: string;
}
```

- [ ] **Step 6: Failing smoke test**

`apps/worker/test/index.spec.ts`:

```ts
import { SELF, createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("responds to /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("scheduled handler runs without error", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledEvent, env, ctx);
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 7: Install deps, run test**

Run: `cd apps/worker; npm install; npx vitest run`
Expected: both tests PASS (health route implemented; scheduled is a stub).

- [ ] **Step 8: Root install + commit**

Run: `cd ..; cd ..; npm install` (workspace links). Then:

```powershell
git init
git add -A
git commit -m "chore: scaffold worker monorepo with D1 schema and shared types"
```

---

### Task 2: Job hashing + dedupe helpers

**Files:**
- Create: `apps/worker/src/lib/hash.ts`
- Test: `apps/worker/test/hash.spec.ts`

**Interfaces:**
- Produces: `makeJobHash(source: string, title: string, company: string, url: string): Promise<string>` (lowercase, whitespace-collapsed inputs, sha256 hex of `source|title|company|url`); `snippet(text: string, max = 800): string` (HTML-entity-lite strip → collapse whitespace → truncate to 800 chars appending `…`).

- [ ] **Step 1: Failing tests**

`apps/worker/test/hash.spec.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeJobHash, snippet } from "../src/lib/hash";

describe("makeJobHash", () => {
  it("is stable across case/whitespace differences", async () => {
    const a = await makeJobHash("remotive", "Senior  React Dev ", "Acme Corp", "https://x.co/1");
    const b = await makeJobHash("Remotive", "senior react dev", "acme   corp", "https://x.co/1");
    expect(a).toBe(b);
  });
  it("differs when url differs", async () => {
    const a = await makeJobHash("remotive", "React Dev", "Acme", "https://x.co/1");
    const b = await makeJobHash("remotive", "React Dev", "Acme", "https://x.co/2");
    expect(a).not.toBe(b);
  });
  it("returns 64-char hex", async () => {
    const h = await makeJobHash("s", "t", "c", "u");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("snippet", () => {
  it("collapses whitespace and strips basic entities", () => {
    expect(snippet("Hello&nbsp;<b>world</b>\n\n   foo")).toBe("Hello world foo");
  });
  it("truncates to max with ellipsis", () => {
    expect(snippet("x".repeat(900), 800)).toHaveLength(801);
    expect(snippet("x".repeat(900), 800)!.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/hash.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/worker/src/lib/hash.ts`:

```ts
const enc = new TextEncoder();

export async function makeJobHash(source: string, title: string, company: string, url: string): Promise<string> {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const data = enc.encode(`${norm(source)}|${norm(title)}|${norm(company)}|${norm(url)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function snippet(text: string, max = 800): string {
  const clean = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + "…";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker; npx vitest run test/hash.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: job hashing and description snippet helpers"
```

---

### Task 3: Source parsers — Remotive, Arbeitnow, RemoteOK (fixtures + tests)

**Files:**
- Create: `apps/worker/src/sources/remotive.ts`, `arbeitnow.ts`, `remoteok.ts`, `types.ts`
- Create: `apps/worker/src/sources/__fixtures__/remotive.json`, `arbeitnow.json`, `remoteok.json` (hand-written minimal samples mirroring real API shapes)
- Test: `apps/worker/test/sources.spec.ts`

**Interfaces:**
- Consumes: `makeJobHash`, `snippet` (Task 2); `NormalizedJob`, `JobSourceSpec` (Task 1 shared types).
- Produces: `SourceParser = (spec: JobSourceSpec, fetchFn: typeof fetch) => Promise<NormalizedJob[]>` and three exports: `parseRemotive(spec, fetchFn)`, `parseArbeitnow(spec, fetchFn)`, `parseRemoteOK(spec, fetchFn)`. Each fetches its endpoint via the injected `fetchFn`, throws on non-2xx, returns `NormalizedJob[]` (may be empty).

- [ ] **Step 1: Fixture files (real API shapes, 2 records each)**

`__fixtures__/remotive.json` — shape per https://remotive.com/api/remote-jobs: `{ "jobs": [ { "id": "...", "url": "...", "title": "...", "company_name": "...", "category": "...", "job_type": "...", "candidate_required_location": "...", "salary": "...", "publication_date": "2026-09-01T10:00:00Z", "description": "<p>html</p>" } ] }` (2 entries).

`__fixtures__/arbeitnow.json` — shape per https://www.arbeitnow.com/api/job-board-api: `{ "data": [ { "slug": "...", "company_name": "...", "title": "...", "description": "<p>html</p>", "remote": true, "url": "...", "tags": ["react"], "job_types": ["full_time"], "location": "Berlin", "created_at": 1725148800 } ] }` (2 entries).

`__fixtures__/remoteok.json` — shape per https://remoteok.com/api: first element is a legal notice object, then job objects: `{ "slug": "...", "position": "...", "company": "...", "location": "Worldwide", "salary_min": 80000, "salary_max": 120000, "url": "https://remoteOK.com/...", "date": "2026-09-01T10:00:00Z", "description": "<p>html</p>" }` (notice + 2 entries). Note `url` fields must be built as `https://remoteok.com/remote-jobs/<slug>` if API returns relative path — fixture uses absolute to keep parser simple.

- [ ] **Step 2: Failing tests**

`apps/worker/test/sources.spec.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { parseRemotive } from "../src/sources/remotive";
import { parseArbeitnow } from "../src/sources/arbeitnow";
import { parseRemoteOK } from "../src/sources/remoteok";
import remotiveFixture from "../src/sources/__fixtures__/remotive.json";
import arbeitnowFixture from "../src/sources/__fixtures__/arbeitnow.json";
import remoteokFixture from "../src/sources/__fixtures__/remoteok.json";

function jsonFetch(body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("remotive parser", () => {
  it("normalizes jobs", async () => {
    const jobs = await parseRemotive({ type: "remotive" } as never, jsonFetch(remotiveFixture));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: remotiveFixture.jobs[0].title,
      company: remotiveFixture.jobs[0].company_name,
      source: "remotive",
    });
    expect(jobs[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(jobs[0].descriptionSnippet.length).toBeLessThanOrEqual(801);
  });
  it("throws on http error", async () => {
    const bad = vi.fn().mockResolvedValue(new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(parseRemotive({ type: "remotive" } as never, bad)).rejects.toThrow(/500/);
  });
});

describe("arbeitnow parser", () => {
  it("normalizes jobs with unix-seconds postedAt", async () => {
    const jobs = await parseArbeitnow({ type: "arbeitnow" } as never, jsonFetch(arbeitnowFixture));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].postedAt).toBe(arbeitnowFixture.data[0].created_at * 1000);
  });
});

describe("remoteok parser", () => {
  it("skips the legal-notice first element", async () => {
    const jobs = await parseRemoteOK({ type: "remoteok" } as never, jsonFetch(remoteokFixture));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].title).toBe(remoteokFixture[1].position);
    expect(jobs[0].salary).toBe("$80000-$120000");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/sources.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement parsers**

`apps/worker/src/sources/types.ts`:

```ts
import type { JobSourceSpec, NormalizedJob } from "@jobfinder/shared";
import { makeJobHash, snippet } from "../lib/hash";

export type SourceParser = (spec: JobSourceSpec, fetchFn: typeof fetch) => Promise<NormalizedJob[]>;

export async function buildJob(
  source: string,
  raw: { title: string; company: string; url: string; location?: string | null; salary?: string | null; postedAt?: number | null; description?: string }
): Promise<NormalizedJob> {
  return {
    hash: await makeJobHash(source, raw.title, raw.company, raw.url),
    title: raw.title.trim(),
    company: raw.company.trim(),
    location: raw.location?.trim() || null,
    salary: raw.salary?.trim() || null,
    url: raw.url.trim(),
    source,
    descriptionSnippet: snippet(raw.description ?? ""),
    postedAt: raw.postedAt ?? null,
  };
}

export async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: { "user-agent": "JobFinderBot/0.1 (personal; contact: owner)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}
```

`apps/worker/src/sources/remotive.ts`:

```ts
import type { JobSourceSpec, NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface RemotiveJob {
  url: string; title: string; company_name: string; candidate_required_location?: string;
  salary?: string; publication_date?: string; description?: string;
}

export const parseRemotive: SourceParser = async (spec: JobSourceSpec, fetchFn): Promise<NormalizedJob[]> => {
  const base = "https://remotive.com/api/remote-jobs?limit=50";
  const url = spec.query ? `${base}&search=${encodeURIComponent(spec.query)}` : base;
  const body = (await fetchJson(url, fetchFn)) as { jobs?: RemotiveJob[] };
  return Promise.all((body.jobs ?? []).map((j) =>
    buildJob("remotive", {
      title: j.title, company: j.company_name, url: j.url,
      location: j.candidate_required_location, salary: j.salary,
      postedAt: j.publication_date ? new Date(j.publication_date).getTime() : null,
      description: j.description,
    })));
};
```

`apps/worker/src/sources/arbeitnow.ts`:

```ts
import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface ArbeitnowJob {
  url: string; title: string; company_name: string; location?: string;
  description?: string; created_at?: number; remote?: boolean;
}

export const parseArbeitnow: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://www.arbeitnow.com/api/job-board-api", fetchFn)) as { data?: ArbeitnowJob[] };
  return Promise.all((body.data ?? []).map((j) =>
    buildJob("arbeitnow", {
      title: j.title, company: j.company_name, url: j.url,
      location: j.remote ? "Remote" : j.location, postedAt: j.created_at ? j.created_at * 1000 : null,
      description: j.description,
    })));
};
```

`apps/worker/src/sources/remoteok.ts`:

```ts
import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface RemoteOkJob {
  slug?: string; position?: string; company?: string; location?: string;
  salary_min?: number; salary_max?: number; url?: string; date?: string; description?: string;
}

export const parseRemoteOK: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://remoteok.com/api", fetchFn)) as RemoteOkJob[];
  return Promise.all(body
    .filter((j) => j && typeof j === "object" && j.position && j.slug)
    .map((j) =>
      buildJob("remoteok", {
        title: j.position!, company: j.company ?? "Unknown",
        url: j.url ?? `https://remoteok.com/remote-jobs/${j.slug}`,
        location: j.location, salary: j.salary_min ? `$${j.salary_min}-${j.salary_max}` : null,
        postedAt: j.date ? new Date(j.date).getTime() : null, description: j.description,
      })));
};
```

Add `"resolveJsonModule": true` to `apps/worker/tsconfig.json` `compilerOptions`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/worker; npx vitest run test/sources.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: remotive/arbeitnow/remoteok source parsers with fixtures"
```

---

### Task 4: Source parsers — Greenhouse + Lever (company slugs)

**Files:**
- Create: `apps/worker/src/sources/greenhouse.ts`, `lever.ts`
- Create: `apps/worker/src/sources/__fixtures__/greenhouse.json`, `lever.json`
- Test: add describe blocks to `apps/worker/test/sources.spec.ts`

**Interfaces:**
- Consumes: `SourceParser`, `buildJob`, `fetchJson` (Task 3).
- Produces: `parseGreenhouse(spec, fetchFn)` — requires `spec.slug` (throws `Error("slug required")` if missing); endpoint `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`; response `{ jobs: [{ title, absolute_url, location: { name }, updated_at, content }] }` where `content` is base64 HTML (decode via `atob` + escape URI handling → description). `parseLever(spec, fetchFn)` — requires `spec.slug`; endpoint `https://api.lever.co/v0/postings/<slug>?mode=json`; response is an array `[{ text, categories: { location, commitment }, hostedUrl, createdAt (unix ms), descriptionPlain }]`. Salary: null for both (not in feeds).

- [ ] **Step 1: Fixtures**

`__fixtures__/greenhouse.json`: `{ "jobs": [ { "title": "Software Engineer", "absolute_url": "https://boards.greenhouse.io/acme/jobs/123", "location": { "name": "Remote" }, "updated_at": "2026-09-01T10:00:00Z", "content": "PGh0bWw+Um9sZTwvaHRtbD4=" } ] }` (2 entries; `content` = base64 of simple HTML).

`__fixtures__/lever.json`: `[ { "text": "Frontend Engineer", "categories": { "location": "Remote", "commitment": "Full-time" }, "hostedUrl": "https://jobs.lever.co/acme/abc", "createdAt": 1725148800000, "descriptionPlain": "Build UIs" } ]` (2 entries).

- [ ] **Step 2: Failing tests (append to sources.spec.ts)**

```ts
import { parseGreenhouse } from "../src/sources/greenhouse";
import { parseLever } from "../src/sources/lever";
import greenhouseFixture from "../src/sources/__fixtures__/greenhouse.json";
import leverFixture from "../src/sources/__fixtures__/lever.json";

describe("greenhouse parser", () => {
  it("decodes base64 content into snippet", async () => {
    const jobs = await parseGreenhouse({ type: "greenhouse", slug: "acme" } as never, jsonFetch(greenhouseFixture));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].descriptionSnippet).toContain("Role");
    expect(jobs[0].source).toBe("greenhouse:acme");
  });
  it("throws when slug missing", async () => {
    await expect(parseGreenhouse({ type: "greenhouse" } as never, jsonFetch(greenhouseFixture))).rejects.toThrow(/slug/);
  });
});

describe("lever parser", () => {
  it("normalizes postings", async () => {
    const jobs = await parseLever({ type: "lever", slug: "acme" } as never, jsonFetch(leverFixture));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].source).toBe("lever:acme");
    expect(jobs[0].postedAt).toBe(1725148800000);
  });
  it("throws when slug missing", async () => {
    await expect(parseLever({ type: "lever" } as never, jsonFetch(leverFixture))).rejects.toThrow(/slug/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/sources.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

`apps/worker/src/sources/greenhouse.ts`:

```ts
import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface GhJob {
  title: string; absolute_url: string; updated_at?: string; content?: string;
  location?: { name?: string };
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  try { return decodeURIComponent(Array.from(bin).map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")); }
  catch { return bin; }
}

export const parseGreenhouse: SourceParser = async (spec, fetchFn): Promise<NormalizedJob[]> => {
  if (!spec.slug) throw new Error("greenhouse: slug required");
  const body = (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(spec.slug)}/jobs?content=true`, fetchFn)) as { jobs?: GhJob[] };
  return Promise.all((body.jobs ?? []).map((j) =>
    buildJob(`greenhouse:${spec.slug}`, {
      title: j.title, company: spec.slug, url: j.absolute_url,
      location: j.location?.name, postedAt: j.updated_at ? new Date(j.updated_at).getTime() : null,
      description: j.content ? decodeBase64(j.content) : "",
    })));
};
```

`apps/worker/src/sources/lever.ts`:

```ts
import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface LeverJob {
  text: string; hostedUrl: string; createdAt?: number; descriptionPlain?: string;
  categories?: { location?: string; commitment?: string };
}

export const parseLever: SourceParser = async (spec, fetchFn): Promise<NormalizedJob[]> => {
  if (!spec.slug) throw new Error("lever: slug required");
  const body = (await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(spec.slug)}?mode=json`, fetchFn)) as LeverJob[];
  return Promise.all(body.map((j) =>
    buildJob(`lever:${spec.slug}`, {
      title: j.text, company: spec.slug, url: j.hostedUrl,
      location: j.categories?.location, postedAt: j.createdAt ?? null,
      description: j.descriptionPlain,
    })));
};
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/worker; npx vitest run test/sources.spec.ts`
Expected: PASS (8 tests total).

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: greenhouse/lever company-board parsers"
```

---

### Task 5: Source registry + Claude scorer with keyword fallback

**Files:**
- Create: `apps/worker/src/sources/registry.ts`
- Create: `apps/worker/src/lib/scorer.ts`
- Create: `apps/worker/src/lib/claude.ts`
- Test: `apps/worker/test/scorer.spec.ts`

**Interfaces:**
- Consumes: all parsers (Tasks 3–4); `UserConfig`, `NormalizedJob`, `ScoredJob` (Task 1).
- Produces:
  - `registry.ts`: `getSourceParser(type: JobSourceSpec["type"]): SourceParser` (map: remotive/arbeitnow/remoteok/greenhouse/lever).
  - `claude.ts`: `scoreJobsBatch(apiKey: string, profile: { fields: string[]; skills: string[] }, jobs: NormalizedJob[], fetchFn: typeof fetch): Promise<Map<string, number>>` — one Claude Haiku call for the whole batch; parses strict JSON `[{hash, score}]`; clamps 0–100; missing hashes absent from map. Also `parseResumeText(apiKey: string, resumeText: string, fetchFn: typeof fetch): Promise<{ fields: string[]; skills: string[] }>`.
  - `scorer.ts`: `scoreJobs(apiKey, profile, jobs, fetchFn): Promise<ScoredJob[]>` — chunks into ≤25-job batches, calls `scoreJobsBatch`, merges; on error falls back to `keywordScore(profile, job)` (score 90 if ≥2 skill hits, 75 if 1, else 0 — hits = case-insensitive skill substring in title+snippet).

- [ ] **Step 1: Failing tests**

`apps/worker/test/scorer.spec.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { scoreJobs, keywordScore } from "../src/lib/scorer";
import { scoreJobsBatch } from "../src/lib/claude";
import type { NormalizedJob } from "@jobfinder/shared";

const job = (over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  hash: "h1", title: "React Dev", company: "Acme", location: "Remote", salary: null,
  url: "https://x.co/1", source: "remotive", descriptionSnippet: "Build UIs with React and TypeScript", postedAt: null, ...over,
});
const profile = { fields: ["Frontend"], skills: ["React", "TypeScript"] };

function claudeFetch(scores: { hash: string; score: number }[]) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(scores) }],
  }), { status: 200 })) as unknown as typeof fetch;
}

describe("scoreJobsBatch", () => {
  it("parses claude json into a score map", async () => {
    const map = await scoreJobsBatch("key", profile, [job()], claudeFetch([{ hash: "h1", score: 87 }]));
    expect(map.get("h1")).toBe(87);
    const [req] = (claudeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req.body).toContain("claude-haiku");
  });
});

describe("scoreJobs", () => {
  it("merges batch scores into ScoredJob[]", async () => {
    const out = await scoreJobs("key", profile, [job()], claudeFetch([{ hash: "h1", score: 92 }]));
    expect(out[0]).toMatchObject({ score: 92 });
  });
  it("falls back to keyword scoring on claude failure", async () => {
    const bad = vi.fn().mockRejectedValue(new Error("api down")) as unknown as typeof fetch;
    const out = await scoreJobs("key", profile, [job()], bad);
    expect(out[0].score).toBe(90); // both React and TypeScript hit
  });
  it("keywordScore: 2+ hits=90, 1 hit=75, 0 hits=0", () => {
    expect(keywordScore(profile, job())).toBe(90);
    expect(keywordScore(profile, job({ title: "Python Dev", descriptionSnippet: "flask stuff" }))).toBe(0);
    expect(keywordScore(profile, job({ title: "React Native Dev", descriptionSnippet: "mobile" }))).toBe(75);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/scorer.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement claude.ts + scorer.ts + registry.ts**

`apps/worker/src/lib/claude.ts`:

```ts
import type { NormalizedJob } from "@jobfinder/shared";

const MODEL = "claude-haiku-4-5-20251001";
const API = "https://api.anthropic.com/v1/messages";

async function callClaude(apiKey: string, system: string, user: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = body.content.find((c) => c.type === "text")?.text ?? "";
  if (!text) throw new Error("Claude returned no text");
  return text;
}

export async function scoreJobsBatch(
  apiKey: string,
  profile: { fields: string[]; skills: string[] },
  jobs: NormalizedJob[],
  fetchFn: typeof fetch
): Promise<Map<string, number>> {
  const system =
    "You are a job-relevance scorer. Given a candidate profile and job postings, score each job 0-100 for fit. " +
    "Respond with ONLY a JSON array like [{\"hash\":\"...\",\"score\":0}] — no markdown, no explanation.";
  const user = JSON.stringify({
    profile: { fields: profile.fields, skills: profile.skills },
    jobs: jobs.map((j) => ({ hash: j.hash, title: j.title, company: j.company, snippet: j.descriptionSnippet.slice(0, 300) })),
  });
  const text = await callClaude(apiKey, system, user, fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { hash: string; score: number }[];
  const map = new Map<string, number>();
  for (const p of parsed) map.set(p.hash, Math.max(0, Math.min(100, Math.round(p.score))));
  return map;
}

export async function parseResumeText(
  apiKey: string, resumeText: string, fetchFn: typeof fetch
): Promise<{ fields: string[]; skills: string[] }> {
  const system = "Extract the candidate's job fields (e.g. 'Frontend', 'Data Engineering') and skills (technologies/tools) from a resume. " +
    "Respond with ONLY JSON: {\"fields\":[...],\"skills\":[...]}.";
  const text = await callClaude(apiKey, system, resumeText.slice(0, 15000), fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { fields?: string[]; skills?: string[] };
  return { fields: (parsed.fields ?? []).map(String).slice(0, 8), skills: (parsed.skills ?? []).map(String).slice(0, 25) };
}
```

`apps/worker/src/lib/scorer.ts`:

```ts
import type { NormalizedJob, ScoredJob, UserConfig } from "@jobfinder/shared";
import { scoreJobsBatch } from "./claude";

export function keywordScore(profile: { skills: string[] }, job: NormalizedJob): number {
  const hay = `${job.title} ${job.descriptionSnippet}`.toLowerCase();
  const hits = profile.skills.filter((s) => hay.includes(s.toLowerCase())).length;
  return hits >= 2 ? 90 : hits === 1 ? 75 : 0;
}

export async function scoreJobs(
  apiKey: string,
  profile: { fields: string[]; skills: string[] },
  jobs: NormalizedJob[],
  fetchFn: typeof fetch
): Promise<ScoredJob[]> {
  if (jobs.length === 0) return [];
  const out: ScoredJob[] = [];
  for (let i = 0; i < jobs.length; i += 25) {
    const chunk = jobs.slice(i, i + 25);
    try {
      const map = await scoreJobsBatch(apiKey, profile, chunk, fetchFn);
      for (const j of chunk) out.push({ job: j, score: map.get(j.hash) ?? keywordScore(profile, j) });
    } catch {
      for (const j of chunk) out.push({ job: j, score: keywordScore(profile, j) });
    }
  }
  return out;
}

export interface ScoringProfile { fields: string[]; skills: string[]; }
export type { UserConfig };
```

`apps/worker/src/sources/registry.ts`:

```ts
import type { JobSourceSpec } from "@jobfinder/shared";
import type { SourceParser } from "./types";
import { parseRemotive } from "./remotive";
import { parseArbeitnow } from "./arbeitnow";
import { parseRemoteOK } from "./remoteok";
import { parseGreenhouse } from "./greenhouse";
import { parseLever } from "./lever";

const PARSERS: Record<JobSourceSpec["type"], SourceParser | undefined> = {
  remotive: parseRemotive, arbeitnow: parseArbeitnow, remoteok: parseRemoteOK,
  greenhouse: parseGreenhouse, lever: parseLever, adzuna: undefined,
};

export function getSourceParser(type: JobSourceSpec["type"]): SourceParser {
  const p = PARSERS[type];
  if (!p) throw new Error(`No parser for source type: ${type}`);
  return p;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker; npx vitest run test/scorer.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: claude batch scorer with keyword fallback + source registry"
```

---

### Task 6: Telegram formatter + sender

**Files:**
- Create: `apps/worker/src/lib/telegram.ts`
- Test: `apps/worker/test/telegram.spec.ts`

**Interfaces:**
- Produces: `formatJobMessage(header: string, jobs: ScoredJob[]): string` — builds the spec §6 format (numbered list, `**Title** @ Company`, match score, location, salary, apply URL) using plain HTML-escaped text with Telegram `parse_mode: "HTML"` (`<b>`, `<i>`). `sendTelegramMessage(token: string, chatId: string, text: string, fetchFn: typeof fetch): Promise<void>` — POST `https://api.telegram.org/bot<token>/sendMessage` with `{chat_id, text, parse_mode: "HTML", disable_web_page_preview: true}`; throws on `ok:false` with description. `chunkForSending(jobs: ScoredJob[], perMessage = 8): { header: string; jobs: ScoredJob[] }[]` — splits sorted jobs into ≤4 messages of 8.

- [ ] **Step 1: Failing tests**

`apps/worker/test/telegram.spec.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { formatJobMessage, sendTelegramMessage, chunkForSending } from "../src/lib/telegram";
import type { ScoredJob } from "@jobfinder/shared";

const sj = (over: Partial<ScoredJob["job"]> = {}, score = 85): ScoredJob => ({
  score,
  job: {
    hash: "h", title: "React Dev", company: "Acme", location: "Remote", salary: "$100k",
    url: "https://x.co/1", source: "remotive", descriptionSnippet: "d", postedAt: null, ...over,
  },
});

describe("formatJobMessage", () => {
  it("escapes html and includes all fields", () => {
    const msg = formatJobMessage("🔥 1 new job — Frontend", [sj({ title: "<Senior> & Co" })]);
    expect(msg).toContain("&lt;Senior&gt; &amp; Co");
    expect(msg).toContain("@ Acme");
    expect(msg).toContain("85/100");
    expect(msg).toContain("https://x.co/1");
    expect(msg).toContain("$100k");
  });
});

describe("chunkForSending", () => {
  it("caps at 4 messages of 8 jobs", () => {
    const jobs = Array.from({ length: 30 }, (_, i) => sj({ hash: `h${i}` }, 100 - i));
    const chunks = chunkForSending(jobs);
    expect(chunks).toHaveLength(4);
    expect(chunks.reduce((n, c) => n + c.jobs.length, 0)).toBe(30);
  });
});

describe("sendTelegramMessage", () => {
  it("posts to bot api and throws on ok:false", async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendTelegramMessage("tok", "123", "hi", ok as unknown as typeof fetch);
    const [url, init] = (ok as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect((init as RequestInit).body).toContain('"chat_id":"123"');
    const bad = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }));
    await expect(sendTelegramMessage("tok", "1", "hi", bad as unknown as typeof fetch)).rejects.toThrow(/chat not found/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/telegram.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/worker/src/lib/telegram.ts`:

```ts
import type { ScoredJob } from "@jobfinder/shared";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatJobMessage(header: string, jobs: ScoredJob[]): string {
  const lines = jobs.map((s, i) => {
    const { title, company, location, salary, url } = s.job;
    const parts = [`<b>${i + 1}. ${esc(title)}</b> @ ${esc(company)}`];
    const meta = [`🎯 Match: ${s.score}/100`];
    if (location) meta.push(`📍 ${esc(location)}`);
    if (salary) meta.push(`💰 ${esc(salary)}`);
    parts.push(`<i>${meta.join(" · ")}</i>`);
    parts.push(`🔗 ${esc(url)}`);
    return parts.join("\n");
  });
  return `${esc(header)}\n\n${lines.join("\n\n")}`;
}

export function chunkForSending(jobs: ScoredJob[], perMessage = 8): { header: string; jobs: ScoredJob[] }[] {
  const top = jobs.slice(0, 30);
  const chunks: { header: string; jobs: ScoredJob[] }[] = [];
  for (let i = 0; i < top.length; i += perMessage) chunks.push({ header: "", jobs: top.slice(i, i + perMessage) });
  return chunks.slice(0, 4);
}

export async function sendTelegramMessage(token: string, chatId: string, text: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || body.ok === false) throw new Error(`Telegram error: ${body.description ?? res.status}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker; npx vitest run test/telegram.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: telegram message formatter and sender"
```

---

### Task 7: runUser orchestrator (fetch → dedupe → score → send → log)

**Files:**
- Create: `apps/worker/src/lib/runUser.ts`
- Test: `apps/worker/test/runUser.spec.ts`

**Interfaces:**
- Consumes: `getSourceParser` (Task 5), `scoreJobs` (Task 5), `chunkForSending`/`sendTelegramMessage` (Task 6), shared types (Task 1). D1 tables from Task 1 migration.
- Produces: `runUser(deps: { db: D1Database; env: { ANTHROPIC_API_KEY: string; TELEGRAM_BOT_TOKEN: string }; fetchFn?: typeof fetch }): Promise<{ status: "ok" | "partial" | "failed"; jobsSent: number }>` — the full pipeline for `user_id='owner'`:
  1. Load config row; if missing/`is_active=0` or no `telegram_chat_id` → return `{status:"failed"}` with error "no config/chat".
  2. Fetch each site via registry (parallel batches of 5, `MAX_SOURCES_PER_RUN` cap); per-source try/catch counting ok/failed.
  3. Concat + dedupe by hash. For each job: `INSERT OR IGNORE INTO jobs` (batched ≤ 40 rows/statement, `first_seen_at=now`); select hashes NOT IN user_jobs for this user.
  4. `scoreJobs` on unseen jobs; keep score ≥ threshold; sort desc.
  5. `chunkForSending` → for each chunk: `formatJobMessage("🔥 N new jobs — <fields>")` → `sendTelegramMessage`; mark sent via batched `UPDATE user_jobs SET sent_at=?, score=?` + inserts into user_jobs for unsent too (score recorded, sent_at null).
  6. Insert `runs` row (always). Return status: `ok` if no source failures and no send errors; `partial` if some; `failed` only if config missing.
- D1 note: keep total writes ≤ 10 statements/run (bulk INSERT OR IGNORE + bulk UPDATE).

- [ ] **Step 1: Failing test (mocks fetchFn + in-memory D1 via cloudflare:test)**

`apps/worker/test/runUser.spec.ts`:

```ts
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
```

Note: the last test — source fetch fails for all sites; no new jobs; nothing sent but run recorded with `sources_failed>0` and status `partial`. If no jobs found, telegram is never called (assert via mock call count if flaky).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/runUser.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement runUser.ts**

`apps/worker/src/lib/runUser.ts`:

```ts
import type { NormalizedJob, ScoredJob, UserConfig } from "@jobfinder/shared";
import { getSourceParser } from "../sources/registry";
import { scoreJobs } from "./scorer";
import { chunkForSending, formatJobMessage, sendTelegramMessage } from "./telegram";

export interface RunUserDeps {
  db: D1Database;
  env: { ANTHROPIC_API_KEY: string; TELEGRAM_BOT_TOKEN: string };
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
  const specs = config.sites.slice(0, cap);
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
    const stmts = [];
    for (let i = 0; i < jobs.length; i += 40) {
      const chunk = jobs.slice(i, i + 40);
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
      const scored = await scoreJobs(deps.env.ANTHROPIC_API_KEY, config, unseenJobs, fetchFn);
      const matches: ScoredJob[] = scored.filter((s) => s.score >= config.scoreThreshold).sort((a, b) => b.score - a.score);

      // record all unseen with scores (sent_at null unless sent)
      const insStmts = [];
      for (let i = 0; i < scored.length; i += 40) {
        const chunk = scored.slice(i, i + 40);
        const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
        const binds = chunk.flatMap((s) => [USER_ID, s.job.hash, now, null, s.score]);
        insStmts.push(deps.db.prepare(`INSERT INTO user_jobs (user_id, job_hash, first_seen_at, sent_at, score) VALUES ${values}`).bind(...binds));
      }
      if (insStmts.length) await deps.db.batch(insStmts);

      let sent = 0;
      if (matches.length > 0 && config.userId === USER_ID) {
        const chunks = chunkForSending(matches);
        for (const c of chunks) {
          const header = `🔥 ${matches.length} new job${matches.length === 1 ? "" : "s"} — ${config.fields.join("/") || "your fields"}`;
          await sendTelegramMessage(deps.env.TELEGRAM_BOT_TOKEN, String(cfgRow.telegram_chat_id), formatJobMessage(header, c.jobs), fetchFn);
          sent += c.jobs.length;
        }
        await deps.db.prepare(`UPDATE user_jobs SET sent_at = ? WHERE user_id = ? AND sent_at IS NULL AND score >= ?`)
          .bind(now, USER_ID, config.scoreThreshold).run();
      }
      const status = sourcesFailed > 0 ? "partial" : "ok";
      await insertRun(deps.db, runId, started, status, sourcesOk, sourcesFailed, jobs.length, sent, undefined, started);
      return { status, jobsSent: sent };
    }
  }

  const status = sourcesFailed > 0 ? "partial" : "ok";
  await insertRun(deps.db, runId, started, status, sourcesOk, sourcesFailed, jobs.length, 0, undefined, started);
  return { status, jobsSent: 0 };
}

async function insertRun(db: D1Database, id: string, startedAt: number, status: string, ok: number, failed: number, found: number, sent: number, error: string | undefined, _start: number) {
  await db.prepare(
    `INSERT INTO runs (id, user_id, started_at, status, sources_ok, sources_failed, jobs_found, jobs_sent, error, duration_ms) VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, startedAt, status, ok, failed, found, sent, error ?? null, Date.now() - startedAt).run();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker; npx vitest run test/runUser.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: runUser orchestrator pipeline with run logging"
```

---

### Task 8: Worker endpoints (run-user, config get/set, health) + scheduled handler + deploy

**Files:**
- Modify: `apps/worker/src/index.ts`, `apps/worker/wrangler.jsonc`
- Create: `apps/worker/src/lib/api.ts` (endpoint logic)
- Test: `apps/worker/test/api.spec.ts`

**Interfaces:**
- Consumes: `runUser` (Task 7); D1 (Task 1).
- Produces (HTTP API used by Task 9 UI):
  - `GET /health` → `{ok:true}`
  - `POST /run-user` (header `x-internal-token: INTERNAL_TOKEN`) → runs `runUser()`, returns result JSON.
  - `GET /config` (internal token) → config row as `UserConfig` JSON + `telegramChatId`.
  - `POST /config` (internal token; body = `UserConfig` + `telegramChatId?`) → upsert row; returns `{ok:true}`.
  - `GET /runs?limit=20` (internal token) → latest runs JSON.
  - `scheduled` handler: `SELECT user_id FROM configs WHERE is_active=1 AND next_run_at <= ?` → for each: `ctx.waitUntil(fetch(selfUrl + "/run-user", {method:"POST", headers:{"x-internal-token": INTERNAL_TOKEN}}))` and bump `next_run_at += cadence_hours*3600*1000`.

- [ ] **Step 1: Failing tests**

`apps/worker/test/api.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";

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
});
```

Test env note: `cloudflare:test` `env` exposes vars from `vitest.config.ts`. Add to `vitest.config.ts` `poolOptions.workers.wrangler` → `vars: { INTERNAL_TOKEN: "test-token", ANTHROPIC_API_KEY: "test", TELEGRAM_BOT_TOKEN: "test" }`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker; npx vitest run test/api.spec.ts`
Expected: FAIL (404 on /config etc.).

- [ ] **Step 3: Implement api.ts + wire index.ts**

`apps/worker/src/lib/api.ts`:

```ts
import type { Env } from "../env";

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const token = req.headers.get("x-internal-token");
  const authorized = token === env.INTERNAL_TOKEN;

  if (path === "/health") return Response.json({ ok: true });

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
      body.isActive ? 1 : 0, body.nextRunAt ?? 0, (body.telegramChatId as string) ?? null, now,
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

  return Response.json({ error: "not found" }, { status: 404 });
}
```

`apps/worker/src/index.ts` (replace):

```ts
import { handleApi } from "./lib/api";
import type { Env } from "./env";

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleApi(req, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    const due = await env.DB.prepare(`SELECT user_id, cadence_hours, next_run_at FROM configs WHERE is_active=1 AND next_run_at <= ?`).bind(now).all<{ user_id: string; cadence_hours: number; next_run_at: number }>();
    for (const row of due.results) {
      await env.DB.prepare(`UPDATE configs SET next_run_at = ? WHERE user_id = ?`).bind(row.next_run_at + row.cadence_hours * 3600_000, row.user_id).run();
      ctx.waitUntil(fetch("https://self/run-user", {
        method: "POST",
        headers: { "x-internal-token": env.INTERNAL_TOKEN, "x-self-url": "1" },
      }).catch(() => {}));
    }
  },
};
```

Self-URL note: Workers doesn't know its own URL at runtime. Fix: add `"vars": { "SELF_URL": "https://jobfinder-worker.<subdomain>.workers.dev" }` to wrangler.jsonc (set real value in Task 9 after first deploy) and use `env.SELF_URL + "/run-user"`. Add `SELF_URL: string` to `Env` in `env.d.ts`, and set `SELF_URL: "http://localhost:8787"` in vitest config vars. Scheduler test: append to api.spec.ts:

```ts
import worker from "../src/index";
it("scheduled bumps next_run_at", async () => {
  await env.DB.prepare(`INSERT INTO configs (user_id, fields, skills, sites, filters, score_threshold, cadence_hours, is_active, next_run_at, telegram_chat_id, updated_at)
    VALUES ('owner', '[]', '[]', '[]', '{}', 70, 2, 1, 0, '1', 1)`).run();
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledEvent, env, ctx);
  const row = await env.DB.prepare(`SELECT next_run_at FROM configs WHERE user_id='owner'`).first<{ next_run_at: number }>();
  expect(row!.next_run_at).toBeGreaterThan(0);
});
```

(`createExecutionContext` import from `cloudflare:test`.)

- [ ] **Step 4: Run all worker tests**

Run: `cd apps/worker; npx vitest run`
Expected: ALL PASS (hash, sources, scorer, telegram, runUser, api).

- [ ] **Step 5: Deploy + wire real IDs**

```powershell
cd apps/worker
npx wrangler d1 create jobfinder-db   # copy database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put INTERNAL_TOKEN   # generate: node -e "console.log(crypto.randomUUID())"
npx wrangler deploy
```

Set `SELF_URL` var to the printed workers.dev URL in wrangler.jsonc, redeploy, then verify: `curl https://jobfinder-worker.<subdomain>.workers.dev/health` → `{"ok":true}`.

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: worker api endpoints, cron scheduler, deploy wiring"
```

---

### Task 9: Next.js UI — config form + dashboard

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx`
- Create: `apps/web/app/api/config/route.ts`, `apps/web/app/api/runs/route.ts`, `apps/web/app/api/run-user/route.ts`, `apps/web/app/api/resume/route.ts`
- Create: `apps/web/components/ConfigForm.tsx`, `components/Dashboard.tsx`
- Create: `apps/web/lib/worker.ts`

**Interfaces:**
- Consumes: Worker API (Task 8); `parseResumeText` logic is re-implemented server-side in the resume route (Vercel function calls Claude directly with `ANTHROPIC_API_KEY` env — pdf text via `pdf-parse`).
- Produces: Pages `/` (single-page app with two tabs: **Setup** and **Dashboard**). All API routes proxy to Worker with `x-internal-token` from env `WORKER_INTERNAL_TOKEN` + `WORKER_URL`.

- [ ] **Step 1: Scaffold app (manual files, no create-next-app interactivity)**

`apps/web/package.json`:

```json
{
  "name": "@jobfinder/web",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": {
    "next": "14.2.15", "react": "^18.3.1", "react-dom": "^18.3.1",
    "pdf-parse": "^1.1.1"
  },
  "devDependencies": {
    "@types/pdf-parse": "^1.1.4", "@types/react": "^18.3.11", "@types/node": "^20",
    "autoprefixer": "^10.4.20", "postcss": "^8.4.47", "tailwindcss": "^3.4.13", "typescript": "^5.6.0"
  }
}
```

`apps/web/next.config.ts`:

```ts
const nextConfig = { serverExternalPackages: ["pdf-parse"] };
export default nextConfig;
```

(`serverExternalPackages` in Next 15+; for Next 14 use `experimental.serverComponentsExternalPackages: ["pdf-parse"]`.)

`apps/web/lib/worker.ts`:

```ts
const BASE = process.env.WORKER_URL!;
const TOKEN = process.env.WORKER_INTERNAL_TOKEN!;

export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-internal-token": TOKEN, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Worker ${path} → ${res.status}`);
  return res;
}
```

API routes (each thin):

`app/api/config/route.ts`:

```ts
import { workerFetch } from "@/lib/worker";
export async function GET() { const r = await workerFetch("/config"); return Response.json(await r.json()); }
export async function POST(req: Request) {
  const body = await req.json();
  const r = await workerFetch("/config", { method: "POST", body: JSON.stringify(body) });
  return Response.json(await r.json());
}
```

`app/api/runs/route.ts` → GET proxies `/runs?limit=20`. `app/api/run-user/route.ts` → POST proxies `/run-user` (no-cache: disable Vercel caching with `export const dynamic = "force-dynamic"`).

`app/api/resume/route.ts` (server-side PDF parse + Claude):

```ts
import { NextRequest } from "next/server";
import pdfParse from "pdf-parse";

export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return Response.json({ error: "no file" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const parsed = await pdfParse(buf);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 1000,
      system: "Extract fields and skills from this resume. Reply ONLY JSON: {\"fields\":[...],\"skills\":[...]}.",
      messages: [{ role: "user", content: parsed.text.slice(0, 15000) }],
    }),
  });
  const body = (await res.json()) as { content?: { text?: string }[] };
  const text = body.content?.[0]?.text ?? "{}";
  return Response.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
}
```

- [ ] **Step 2: Build the two-tab page**

`apps/web/components/ConfigForm.tsx` — client component:
- Loads `GET /api/config` on mount; local state for `fields[]`, `skills[]`, `sites[]`, `scoreThreshold`, `cadenceHours`, `telegramChatId`, `isActive`.
- Skills/tags editor: text input + Enter to add, × to remove (chip UI).
- Sites editor: checkboxes for remotive/arbeitnow/remoteok; for greenhouse/lever — slug text input + "Add board" button; list of added slugs with remove.
- Telegram: text input for chat ID + help text ("@userinfobot se apna chat ID lo") + "Send test" button (calls `/api/run-user`... no — a `POST /api/telegram-test` route → Worker `/telegram-test` endpoint that sends "✅ Job Finder connected!" via `sendTelegramMessage`; add that endpoint to api.ts in this task: `POST /telegram-test` internal, body `{chatId}` → sends test message).
- Resume: file input → POST `/api/resume` → merge returned fields/skills into chips.
- Save button → `POST /api/config`.

`apps/web/components/Dashboard.tsx` — client component:
- "Run now" button → `POST /api/run-user` → shows result status + jobsSent.
- Runs table: loads `GET /api/runs` (started_at formatted, status badge ok/partial/failed, sources ok/failed, jobs found/sent).
- Auto-refresh every 60s.

`app/page.tsx` renders tabs, `layout.tsx` sets `<html lang="en"><body class="bg-neutral-50 text-neutral-900">`, Tailwind via `globals.css` (`@tailwind base; @tailwind components; @tailwind utilities;`).

- [ ] **Step 3: Worker /telegram-test endpoint**

Add to `apps/worker/src/lib/api.ts` before the 404:

```ts
if (path === "/telegram-test" && req.method === "POST") {
  const { chatId } = (await req.json()) as { chatId: string };
  const { sendTelegramMessage } = await import("./telegram");
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "✅ Job Finder connected!", fetch);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Run web dev + manual verify**

```powershell
cd apps/web
npm install
npm run dev    # http://localhost:3000
```

Manual checks: save config with one skill + remotive → `GET /api/config` returns it; upload a PDF resume → fields/skills chips populate; press "Send test" → Telegram message arrives (real token needed); press "Run now" → run row appears in dashboard.

- [ ] **Step 5: Build check + commit**

```powershell
npm run build   # must succeed
git add -A
git commit -m "feat: web ui with config form, resume parse, dashboard, telegram test"
```

---

### Task 10: End-to-end wiring + first real run

**Files:**
- Modify: none (verification + `.env.example` + README)

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Env files**

`apps/web/.env.local` (gitignored — create `.env.example` with empty values committed):
```
WORKER_URL=https://jobfinder-worker.<subdomain>.workers.dev
WORKER_INTERNAL_TOKEN=<same as worker secret>
ANTHROPIC_API_KEY=<claude key>
```

`apps/worker/.dev.vars` (gitignored; example committed as `.dev.vars.example`):
```
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
INTERNAL_TOKEN=...
SELF_URL=http://localhost:8787
```

Root `.gitignore`:
```
node_modules/
.next/
.dev.vars
.env*.local
.wrangler/
```

- [ ] **Step 2: Local end-to-end smoke**

```powershell
cd apps/worker; npm run db:migrate; npm run dev    # terminal 1
cd apps/web; npm run dev                            # terminal 2 (WORKER_URL=http://localhost:8787)
```

Manual: configure skills + remotive + real chat ID → Send test → Run now → Telegram message with real scored jobs → run row `ok`.

- [ ] **Step 3: Remote deploy + real cron**

Redeploy web to Vercel (`npx vercel` with env vars set in dashboard), ensure worker deployed (Task 8) with real `SELF_URL`, confirm cron active (`npx wrangler triggers` or dashboard). Wait for next 10-min tick → verify `runs` table has entries → Telegram receives jobs within the hour.

- [ ] **Step 4: README + commit**

`README.md` (root): what the app is, architecture diagram (copy from spec §3), local dev commands, deploy checklist (d1 create → migrate → secrets → deploy → SELF_URL → vercel env), Telegram chat ID instructions. Commit all:

```powershell
git add -A
git commit -m "docs: readme and env examples; mvp end-to-end verified"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1–2 (schema, hashing), 3–4 (sources catalog), 5 (LLM scoring + fallback), 6 (telegram format/limits), 7 (runner pipeline + run logs), 8 (scheduler fan-out + endpoints + deploy), 9 (UI: config, resume parse, dashboard, telegram test), 10 (env wiring, e2e, README). Spec §6 "Run now" ✓ (Task 9), §7 resume parse ✓ (Task 9), §11 error handling ✓ (runUser statuses), §12 internal-token auth ✓ (Task 8), one-click connect + webhook = phase 2 (spec §8 MVP shortcut = manual chat ID ✓).
- **Type consistency:** `SourceParser` signature consistent across Tasks 3–5; `ScoredJob`/`NormalizedJob` from shared types used in Tasks 5–7; `runUser` deps/result shape consistent Tasks 7–8.
- **Known simplifications (intentional, MVP):** dedupe query keys on `first_seen_at = now` (safe because run-scoped); `user_jobs` UPDATE sets all ≥ threshold rows after send (assumes send success for the chunk — retry semantics deferred to phase 2); Adzuna deferred (registry throws).
