import type { Env } from "./env";

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
