# Job Finder — Design Document

**Date:** 2026-09-07
**Status:** Approved design (pending implementation plan)
**Product:** Multi-user SaaS that delivers personalized job postings to each user's Telegram, on autopilot.

---

## 1. Problem & Product Vision

Job seekers miss relevant postings because they can't watch dozens of job boards all day. Job Finder lets a user describe their profile (via resume + manual skills), pick target sources, connect Telegram in one click, and receive fresh, relevance-scored job alerts continuously.

**Core user flow (final product):**

1. Sign up on the website → subscribe (phase 3)
2. Upload resume → system detects fields/skills → user confirms/edits, adds manual skills
3. Select target sources: preset free job APIs + company-specific ATS boards (Greenhouse/Lever), as many as they want (capped per run)
4. One-click Telegram connect via our official bot
5. Receive scored, deduped job alerts on their cadence — indefinitely

## 2. Key Decisions (locked)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Build order | Personal MVP first (single user), SaaS layer after | Validate scraping+scoring+delivery before multi-user complexity |
| 2 | Job sources | Public APIs + ATS public boards only | LinkedIn/Indeed/Naukri scraping violates ToS and breaks constantly |
| 3 | Resume parsing | PDF → text → Claude Haiku extracts fields/skills | Accurate, ~₹1/resume, minimal code |
| 4 | Job matching | LLM relevance scoring (0–100) per job per user | Feed quality is the product |
| 5 | MVP cadence | Hourly cron, single user | Fast feedback loop |
| 6 | Backend model | **Model A: everything central** (our Cloudflare Worker) | Code never reaches users → nothing to copy/paste; auth+subscription is the only gate needed |
| 7 | Telegram | **Single official bot @YourJobFinderBot**, one-click connect | Zero friction vs. BotFather DIY; we control the channel |
| 8 | Infra | Next.js UI on Vercel (free) + one Cloudflare Worker + D1 (free → $5/mo) | ₹0 fixed cost to start; upgrade path is a plan toggle, no architecture change |

**Rejected alternative worth remembering:** BYO-cloud runtime (user deploys their own Worker via "Deploy to Cloudflare" button). Rejected because anything in the user's account can be copied/edited by a technical user; even with license-gating of the LLM endpoints, the scraping core leaks. Central model has no artifact to leak.

## 3. Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│ Next.js Web UI (Vercel)      │         │ Central Worker (Cloudflare, ours)     │
│ • Auth (Better Auth)         │  HTTPS  │ • Cron trigger every 10 min:          │
│ • Onboarding wizard:         │────────▶│    find due users → self-fetch fan-out│
│   resume → fields → skills   │         │ • Per-run invocation:                 │
│   → sites → Telegram connect │         │    scrape sources → dedupe →          │
│ • Dashboard: feed, run logs, │         │    Claude score → Telegram send       │
│   settings, billing          │         │ • Telegram webhook: /telegram         │
│ • Resume parse (pdf-parse +  │         │   (one-click connect capture)         │
│   Claude, via API route)     │         │ • D1: users, configs, jobs, runs      │
└─────────────────────────────┘         └──────────────────────────────────────┘
```

### 3.1 Components

| Unit | Responsibility | Interface | Depends on |
|------|---------------|-----------|------------|
| **Web UI** (Next.js, Vercel) | Auth, onboarding wizard, dashboard, settings | Calls Worker REST API (internal token + user session) | Worker API, Vercel |
| **Worker — scheduler** | Every 10 min: find due configs, spawn one self-fetch per due user | Cron trigger + `runUser(userId)` fetch | D1 |
| **Worker — runner** | One user's full cycle: fetch sources → normalize+dedupe → score → send → log | Internal `POST /run-user` | D1, source APIs, Claude API, Telegram API |
| **Worker — source parsers** | Normalizes each job source into `{title, company, location, salary?, url, postedAt, descriptionSnippet}` | Pure functions over HTTP responses | Source APIs |
| **Worker — scorer** | Batches 20–30 new jobs + user profile → Claude Haiku → scores JSON. Keyword-filter fallback on API failure | Internal module | Claude API |
| **Worker — telegram** | Message formatting (5–10 jobs/message), rate-safe sending, webhook for connect codes | `sendMessage`, `POST /telegram` | Telegram Bot API |
| **D1** | All state | SQL | — |

### 3.2 Why self-fetch fan-out (subrequest budget)

Cloudflare Workers allow **50 subrequests per invocation** (free) / 10,000 (paid). One cron tick can't scrape many users serially. Solution: the scheduled handler only *queries due users* and does a `fetch()` to our own Worker endpoint per user. Each spawned invocation gets a **fresh subrequest budget**, so capacity scales with users, not with the tick's budget.

## 4. Data Model (D1)

```sql
-- Phase 2+ (MVP uses a single seeded row)
users (
  id TEXT PK, email TEXT UNIQUE, name TEXT,
  plan TEXT DEFAULT 'free',            -- free | pro
  subscription_status TEXT DEFAULT 'inactive',  -- active | past_due | canceled
  telegram_chat_id TEXT, telegram_connected_at INTEGER,
  created_at INTEGER
)

configs (
  user_id TEXT PK REFERENCES users,
  fields JSON,        -- e.g. ["Frontend","Full-stack"]
  skills JSON,        -- e.g. ["React","Next.js","TypeScript"]
  sites JSON,         -- [{type:"remotive"}, {type:"greenhouse", slug:"stripe"}, ...]
  filters JSON,       -- {remoteOnly: bool, countries: [], keywords: []}
  score_threshold INTEGER DEFAULT 70,
  cadence_hours INTEGER DEFAULT 1,   -- MVP (owner): 1 = hourly; SaaS users: min 2 on free plan
  is_active INTEGER DEFAULT 1,
  next_run_at INTEGER               -- unix ms; scheduler queries this
)

jobs (                                -- global catalog, deduped by content hash
  hash TEXT PK,                       -- sha256(source|title|company|url)
  title TEXT, company TEXT, location TEXT, salary TEXT,
  url TEXT, source TEXT, description_snippet TEXT,
  posted_at INTEGER, first_seen_at INTEGER
)

user_jobs (                           -- per-user dedupe + delivery state
  user_id TEXT, job_hash TEXT REFERENCES jobs,
  first_seen_at INTEGER, sent_at INTEGER, score INTEGER,
  PRIMARY KEY (user_id, job_hash)
)

runs (                                -- observability: every run, every user
  id TEXT PK, user_id TEXT, started_at INTEGER, status TEXT, -- ok | partial | failed
  sources_ok INTEGER, sources_failed INTEGER,
  jobs_found INTEGER, jobs_sent INTEGER, error TEXT, duration_ms INTEGER
)

connect_codes (                       -- one-click Telegram connect (phase 2)
  code TEXT PK, user_id TEXT, expires_at INTEGER, used_at INTEGER
)
```

**Write-budget note:** `user_jobs` inserts are batched; `jobs` uses `INSERT OR IGNORE`. Target ≤ 10 D1 writes per user-run to protect the free-plan daily write quota (100K/day).

## 5. Job Sources Catalog (all free & ToS-safe)

| Source | Type | Access | Custom targets? |
|--------|------|--------|-----------------|
| Remotive | REST API | No key | — |
| Arbeitnow | REST API | No key | — |
| RemoteOK | Public JSON feed | No key | — |
| Greenhouse | Per-company public board JSON (`boards-api.greenhouse.io`) | No key | ✅ user adds company slugs |
| Lever | Per-company public postings JSON (`api.lever.co`) | No key | ✅ user adds company slugs |
| Adzuna | REST API | Free key (ours, app-level) | keyword/country search |

- **Custom target site flow:** user types a company name → we probe Greenhouse + Lever for the slug → found → saved as a board. Unfound → clear error message.
- **Per-run cap:** ~15–20 source fetches per run (keeps subrequests + D1 + LLM cost bounded). Users wanting more can raise cadence instead.
- **Source health:** each source failure logged per-run; 3 consecutive failures → warning badge in dashboard.

## 6. Scheduling & Delivery

- **One cron trigger, every 10 min** (free plan allows 5; we use 1).
- Handler: `SELECT user_id FROM configs WHERE is_active=1 AND next_run_at <= now` → spawn `run-user` fetch per due user → set `next_run_at += cadence_hours`.
- **MVP cadence:** hourly (owner only, per the locked decision). Post-MVP SaaS defaults may be 2h, but the system itself is cadence-agnostic.
- **Runner flow:** load config → fetch sources (parallel batches of 5–6, respecting the 6-connection limit) → normalize → `INSERT OR IGNORE` into `jobs` → find user-unseen → score → filter ≥ threshold → format 5–10 jobs per Telegram message → send → write `user_jobs` + `runs`.
- **Message format:**

  ```
  🔥 4 new jobs for you — Frontend/React

  1. Senior Frontend Engineer @ Stripe  — Match 92/100
     📍 Remote(India) · 💰 $120k–160k
     🔗 apply link

  2. ...
  ```

- **Rate safety:** ≤ 4 messages/min per chat; if a run yields > 30 jobs, deliver top 30 by score, note the rest in the dashboard feed.
- **"Run now" button:** dashboard → `run-user` immediately (respects dedupe), for testing and impatience.

## 7. LLM Usage (Claude API — our key, server-side only)

| Task | Model | Frequency | Cost control |
|------|-------|-----------|--------------|
| Resume parse (PDF text → fields+skills JSON) | Haiku | Once per user (re-parse on re-upload) | ~₹1–2/call |
| Job relevance scoring (profile + 20–30 jobs → JSON scores) | Haiku | Per run, batched | 1–2 calls/run; fallback to keyword filter on error |
| (Phase 3) Cheap rerank for digest if needed | Haiku | — | — |

- Scoring prompt returns strict JSON `[{hash, score, reason?}]`; validate+clamp scores; missing → keyword fallback.
- Per-user monthly token metering stored for admin cost tracking (phase 3); protects against a user hammering "Run now".

## 8. Telegram — Single Official Bot, One-Click Connect

- We own **@YourJobFinderBot**; token is a Worker secret.
- **Connect flow:** UI button → generate short-lived code → open `https://t.me/YourJobFinderBot?start=<code>` → user presses START → Telegram webhook (`POST /telegram` on Worker) matches code → binds `chat_id` to user → confirmation message sent → UI polls & shows "Connected ✓".
- MVP (phase 1) shortcut: paste chat ID manually (from @userinfobot) — bot is already ours, webhook code lands in phase 2.
- Message throttling: respect Telegram's ~30 msg/sec global and 1 msg/sec per chat limits via a simple queue/delay.

## 9. Protection / Anti-Abuse (why nothing can be "sold for free")

1. **No runtime code ships to users** — scraping/scoring logic exists only in our Worker. Nothing to download, fork, or re-deploy.
2. **Auth + subscription gate every API path.** Web UI calls the Worker only with a session-bound token; runs only execute for `subscription_status = active` (phase 3+; MVP: the single seeded admin user).
3. LLM keys, prompts, source catalog details never leave the server.
4. Per-user run metering + cost tracking (phase 3) flags abuse.
5. Public source APIs are the only "trade secret" exposure — and they're public anyway.

## 10. Capacity & Scaling Plan

Verified Cloudflare numbers (Sep 2026 docs):

| Limit | Free | Paid ($5/mo) |
|-------|------|--------------|
| Requests/day | 100K | 10M/mo |
| Subrequests/invocation | **50** | **10,000** |
| D1 writes | 100K/day | 50M/mo included |
| D1 reads | 5M/day | 25B/mo included |
| Cron triggers | 5 | 250 |

**Model:** ~10–15 subrequests + ~5–10 D1 writes per user-run.

| Scenario | Free-plan capacity (users × 3 automations) |
|----------|-------------------------------------------|
| Hourly cadence | ~80 users |
| Every 2 h | ~160 users |
| Every 3 h | ~240 users |

**Upgrade path:** at ~50 users, flip to Workers Paid → limits stop mattering until ~3,000+ users. **Zero architecture changes** required; at very large scale, Cloudflare Queues replaces self-fetch fan-out (isolated, later phase).

## 11. Error Handling & Observability

- Every source fetch: try/catch → `runs.sources_failed` + error text; one bad source never kills a run.
- LLM failure → keyword-filter fallback + run marked `partial`.
- Telegram failure → retry ×2 with backoff; then run marked `partial` with error.
- Run write is unconditional — a user's dashboard always shows last-run status; silent failures impossible.
- Worker logs (200K events/day free) + `runs` table as source of truth.
- (Phase 3) admin dashboard: users, runs, LLM spend, failing sources.

## 12. Security

- Secrets (Anthropic key, bot token, internal API token, session secret) = Worker/Vercel env only.
- `POST /run-user` and scheduler endpoints: internal shared-secret header; never public-callable without it.
- Telegram webhook: verify Telegram secret-token header.
- D1 access only via the Worker; UI never touches D1 directly.
- Rate limit public endpoints (login, connect-code) to curb abuse.
- PII kept minimal: email, name, resume-derived skills, chat ID. Resume file stored transiently (parsed → discarded) in MVP.

## 13. Testing Strategy

- **Unit (Vitest):** source parsers against recorded fixtures (one per source), hash/dedupe logic, message formatter (snapshot), scoring JSON validation + fallback, scheduler due-user query, connect-code expiry.
- **Integration:** `run-user` end-to-end with mocked source APIs + mocked Claude + mocked Telegram → assert D1 state + outbound payloads.
- **Manual:** real Telegram test chat; real "Run now"; BotFather webhook verification.
- Each new source = fixture + parser test before it enters the catalog.

## 14. Build Phases

| Phase | Scope | Est. |
|-------|-------|------|
| **1 — MVP (single user = owner)** | Worker + D1 schema + sources + dedupe + LLM scoring + Telegram send (manual chat ID) + minimal settings UI + dashboard w/ run logs + "Run now" | ~1.5–2 wks part-time |
| **2 — SaaS layer** | Auth (Better Auth), multi-user scheduler (self-fetch fan-out), onboarding wizard, one-click Telegram connect, source catalog UI | ~2 wks |
| **3 — Monetization** | Razorpay/Stripe subscriptions, gate runs on active subscription, admin dashboard (users/runs/costs), landing page polish | ~1–2 wks |
| **4 — Scale** | Queues migration, more sources, source-health alerts, per-user LLM budget caps | as needed |

**Costs:** fixed ₹0 at launch (Vercel Hobby + Cloudflare free; $5/mo Cloudflare at ~50 users); variable = Claude API only, per-user, covered by subscription pricing.

## 15. Out of Scope (v2 backlog)

- LinkedIn/Indeed/Naukri scraping (ToS + reliability — permanently out unless via official partnerships)
- Per-user BotFather bots (replaced by official bot)
- Mobile app; email delivery channel; job application autofill
- Resume tailoring suggestions (possible future upsell — Resume Tailor is a natural feature)

## 16. Open Questions

- Pricing (₹199/mo? ₹499/mo?) — decide at phase 3 with real usage costs in hand.
- Adzuna key: ours (app-level, shared quota) vs. skip in MVP → **decided: ours, added late MVP if catalog feels thin.**
- Digest mode (morning/evening summary instead of drip) — candidate phase-4 feature, not MVP.
