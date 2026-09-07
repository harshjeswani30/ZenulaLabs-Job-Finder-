# Job Finder

Telegram job feed, MVP (single user): a Cloudflare Worker scrapes free job APIs + company ATS boards hourly, dedupes jobs, scores relevance against your profile with Claude Haiku, and sends matches to your Telegram. A Next.js UI configures everything and shows run history.

## Architecture

- **`apps/worker`** — Cloudflare Worker (TypeScript): cron every 10 min finds due users → self-fetch fan-out per user → per-user runner: fetch sources (Remotive, Arbeitnow, RemoteOK, Greenhouse boards, Lever boards) → normalize + hash-dedupe → D1 storage → Claude Haiku relevance scoring (keyword fallback if the API fails) → Telegram messages (top 30 jobs, 8 per message, HTML-formatted) → run logged.
- **`apps/web`** — Next.js 14 (app router) + Tailwind on Vercel: Setup tab (skills/fields chips, site selection, Greenhouse/Lever company slugs, score threshold, cadence, Telegram chat ID + test button, PDF resume upload → Claude field/skill extraction) and Dashboard tab (Run now, runs table with status badges, 60s auto-refresh).
- **`packages/shared`** — shared TypeScript types.
- **D1** tables: `configs`, `jobs`, `user_jobs`, `runs`.

The web app never talks to D1 directly — it proxies to the Worker over HTTP with a shared `x-internal-token`. All secrets are server-side env/worker-secrets; nothing ships to users.

## Local development

Prereqs: Node 20+, npm.

```powershell
npm install
```

**Worker** (terminal 1):

```powershell
cd apps/worker
Copy-Item .dev.vars.example .dev.vars   # then fill real values in .dev.vars
npm run db:migrate                       # local D1
npm run dev                              # http://localhost:8787
```

**Web** (terminal 2):

```powershell
cd apps/web
Copy-Item .env.example .env.local        # WORKER_URL=http://localhost:8787, WORKER_INTERNAL_TOKEN must match worker's INTERNAL_TOKEN
npm run dev                              # http://localhost:3000
```

Tests (worker): `cd apps/worker; npx vitest run`. Typecheck: `npx tsc --noEmit`. Web build: `cd apps/web; npm run build`.

## Deploy checklist

### 1. Cloudflare (worker + database)

```powershell
cd apps/worker
npx wrangler login
npx wrangler d1 create jobfinder-db
```

Copy the printed `database_id` into `apps/worker/wrangler.jsonc` (replace `PLACEHOLDER_CREATE_VIA_WRANGLER`).

```powershell
npm run db:migrate:remote
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put INTERNAL_TOKEN   # generate first: node -e "console.log(crypto.randomUUID())"
npx wrangler deploy
```

Note the printed `https://jobfinder-worker.<subdomain>.workers.dev` URL. Put it in `wrangler.jsonc` → `vars.SELF_URL` (replace `PLACEHOLDER_SET_AFTER_FIRST_DEPLOY`), then `npx wrangler deploy` again. Verify: `curl https://jobfinder-worker.<subdomain>.workers.dev/health` → `{"ok":true}`.

### 2. Telegram bot + chat ID

- Bot token: message **@BotFather** → `/newbot` → copy the token (`123456:ABC-...`).
- Your chat ID: message **@userinfobot** → copy the numeric ID.
- Test from the UI's "Send test" button after deploying the web app.

### 3. Anthropic API key

Create at [console.anthropic.com](https://console.anthropic.com) → API keys. Add ~₹500 credit; MVP usage is roughly ₹100–300/month.

### 4. Web app (Vercel)

```powershell
cd apps/web
npx vercel
```

Set env vars in the Vercel dashboard: `WORKER_URL` (the workers.dev URL), `WORKER_INTERNAL_TOKEN` (same value as the worker secret), `GROQ_API_KEY`.

### 5. First run

Open the web app → Setup tab → add skills, tick Remotive, paste chat ID → **Send test** (message arrives in Telegram) → Save → Dashboard tab → **Run now**. After that the cron delivers scored jobs on your cadence.

## Cost profile

Fixed ₹0 at MVP scale (Cloudflare free tier + Vercel Hobby). Variable: Groq API per scoring/resume call (gpt-oss-120b — free tier) — the only recurring cost, covered by usage budget above. Upgrade to Workers Paid ($5/mo) only past ~50 users (MVP has none — single owner).
