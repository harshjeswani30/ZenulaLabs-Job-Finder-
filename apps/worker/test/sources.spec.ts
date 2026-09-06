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
