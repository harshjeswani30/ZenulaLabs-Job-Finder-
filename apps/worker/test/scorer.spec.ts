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
    const fetchMock = claudeFetch([{ hash: "h1", score: 87 }]);
    const map = await scoreJobsBatch("key", profile, [job()], fetchMock);
    expect(map.get("h1")).toBe(87);
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).body).toContain("claude-haiku");
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
