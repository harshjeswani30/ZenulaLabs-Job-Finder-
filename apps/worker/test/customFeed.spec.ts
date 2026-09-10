import { describe, it, expect, vi } from "vitest";
import { parseCustomFeed, isValidCustomFeedUrl } from "../src/sources/customFeed";

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Acme Jobs</title>
  <item>
    <title>Senior Frontend Engineer</title>
    <link>https://acme.example/jobs/1</link>
    <description><![CDATA[React + TypeScript role on the platform team.]]></description>
    <pubDate>Mon, 07 Sep 2026 10:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Backend Engineer</title>
    <link>https://acme.example/jobs/2</link>
    <description>Node.js role.</description>
  </item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Data Annotator</title>
    <link href="https://anno.example/jobs/9" />
    <summary>Annotate AI training data.</summary>
    <published>2026-09-06T08:00:00Z</published>
  </entry>
</feed>`;

function xmlFetch(body: string, status = 200) {
  return vi.fn().mockResolvedValue(new Response(body, { status })) as unknown as typeof fetch;
}

describe("isValidCustomFeedUrl", () => {
  it("accepts http(s) URLs and rejects garbage", () => {
    expect(isValidCustomFeedUrl("https://example.com/feed.xml")).toBe(true);
    expect(isValidCustomFeedUrl("http://example.com/rss")).toBe(true);
    expect(isValidCustomFeedUrl("ftp://example.com/feed")).toBe(false);
    expect(isValidCustomFeedUrl("not a url")).toBe(false);
    expect(isValidCustomFeedUrl("")).toBe(false);
  });
});

describe("parseCustomFeed", () => {
  it("parses an RSS feed with custom slug label", async () => {
    const jobs = await parseCustomFeed(
      { type: "custom", query: "https://acme.example/feed.xml", slug: "Acme" },
      xmlFetch(RSS_XML)
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: "Senior Frontend Engineer",
      company: "Acme",
      source: "custom:Acme",
      url: "https://acme.example/jobs/1",
    });
    expect(jobs[0].postedAt).toBe(new Date("Mon, 07 Sep 2026 10:00:00 +0000").getTime());
    expect(jobs[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the label from the hostname when no slug is given", async () => {
    const jobs = await parseCustomFeed(
      { type: "custom", query: "https://jobs.acme.io/feed" },
      xmlFetch(ATOM_XML)
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Data Annotator",
      company: "jobs.acme.io",
      source: "custom:jobs.acme.io",
      url: "https://anno.example/jobs/9",
    });
  });

  it("throws on missing/invalid URL", async () => {
    await expect(parseCustomFeed({ type: "custom" }, xmlFetch(RSS_XML))).rejects.toThrow(/invalid URL/i);
    await expect(
      parseCustomFeed({ type: "custom", query: "javascript:alert(1)" }, xmlFetch(RSS_XML))
    ).rejects.toThrow(/invalid URL/i);
  });

  it("throws on http error", async () => {
    await expect(
      parseCustomFeed({ type: "custom", query: "https://acme.example/feed" }, xmlFetch("nope", 404))
    ).rejects.toThrow(/404/);
  });

  it("redirects lever board URLs to the company-board feature with a hint", async () => {
    await expect(
      parseCustomFeed({ type: "custom", query: "https://jobs.lever.co/rws" }, xmlFetch(RSS_XML))
    ).rejects.toThrow(/slug "rws"/);
  });

  it("rejects plain HTML pages that are not feeds", async () => {
    const html = "<!DOCTYPE html><html><body>jobs page</body></html>";
    await expect(
      parseCustomFeed({ type: "custom", query: "https://acme.example/jobs" }, xmlFetch(html))
    ).rejects.toThrow(/did not return an RSS\/Atom feed/);
  });
});
