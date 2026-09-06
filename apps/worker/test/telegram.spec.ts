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
