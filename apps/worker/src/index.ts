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
      await env.DB.prepare(`UPDATE configs SET next_run_at = ? WHERE user_id = ?`).bind(row.next_run_at + row.cadence_hours * 3_600_000, row.user_id).run();
      ctx.waitUntil(fetch(`${env.SELF_URL}/run-user`, {
        method: "POST",
        headers: { "x-internal-token": env.INTERNAL_TOKEN, "x-user-id": row.user_id },
      }).catch(() => {}));
    }
  },
};
