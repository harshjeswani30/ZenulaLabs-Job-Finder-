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
