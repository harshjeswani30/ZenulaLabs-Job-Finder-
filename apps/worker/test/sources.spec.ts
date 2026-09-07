import { describe, it, expect, vi } from "vitest";
import { parseRemotive } from "../src/sources/remotive";
import { parseArbeitnow } from "../src/sources/arbeitnow";
import { parseRemoteOK } from "../src/sources/remoteok";
import remotiveFixture from "../src/sources/__fixtures__/remotive.json";
import arbeitnowFixture from "../src/sources/__fixtures__/arbeitnow.json";
import remoteokFixture from "../src/sources/__fixtures__/remoteok.json";
import { parseGreenhouse } from "../src/sources/greenhouse";
import { parseLever } from "../src/sources/lever";
import greenhouseFixture from "../src/sources/__fixtures__/greenhouse.json";
import leverFixture from "../src/sources/__fixtures__/lever.json";
import { parseSmartRecruiters } from "../src/sources/smartrecruiters";
import smartrecruitersFixture from "../src/sources/__fixtures__/smartrecruiters.json";

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

describe("smartrecruiters parser", () => {
  it("normalizes postings with refs landingPage", async () => {
    const jobs = await parseSmartRecruiters({ type: "smartrecruiters", slug: "Acme" } as never, jsonFetch(smartrecruitersFixture[0]));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: "Senior Software Engineer, Platform",
      source: "smartrecruiters:Acme",
      url: "https://jobs.smartrecruiters.com/Acme/2026-001",
    });
    expect(jobs[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(jobs[1].location).toBe("Remote, USA");
  });
  it("throws when slug missing", async () => {
    await expect(parseSmartRecruiters({ type: "smartrecruiters" } as never, jsonFetch(smartrecruitersFixture[0]))).rejects.toThrow(/slug/);
  });
});

import { parseWeWorkRemotely, parseBerlinStartupJobs } from "../src/sources/rssBoards";

const WWR_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Veracode: Principal Account Executive</title><link>https://weworkremotely.com/job/1</link><description>Sell security</description><pubDate>Mon, 07 Sep 2026 10:00:00 +0000</pubDate></item>
<item><title>Legion: Director of Production Engineering</title><link>https://weworkremotely.com/job/2</link><description>Run infra</description></item>
</channel></rss>`;

function xmlFetch(body: string) {
  return vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/xml" } })) as unknown as typeof fetch;
}

describe("weworkremotely parser", () => {
  it("splits company:title and normalizes", async () => {
    const jobs = await parseWeWorkRemotely({ type: "weworkremotely" } as never, xmlFetch(WWR_XML));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ title: "Principal Account Executive", company: "Veracode", source: "weworkremotely" });
  });
  it("query maps to category feed", async () => {
    const mock = xmlFetch(WWR_XML);
    await parseWeWorkRemotely({ type: "weworkremotely", query: "remote-programming-jobs" } as never, mock);
    const [url] = (mock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("remote-programming-jobs");
  });
});

describe("berlinstartupjobs parser", () => {
  it("normalizes RSS with company split", async () => {
    const jobs = await parseBerlinStartupJobs({ type: "berlinstartupjobs" } as never, xmlFetch(WWR_XML));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].company).toBe("Veracode");
    expect(jobs[0].source).toBe("berlinstartupjobs");
  });
});
