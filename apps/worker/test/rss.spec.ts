import { describe, it, expect } from "vitest";
import { parseRssItems, splitCompanyTitle } from "../src/sources/rss";

const SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>We Work Remotely</title>
<item>
  <title>Veracode: Principal Account Executive</title>
  <link>https://weworkremotely.com/job/1</link>
  <description>&lt;p&gt;Sell security stuff&lt;/p&gt;</description>
  <pubDate>Mon, 07 Sep 2026 10:00:00 +0000</pubDate>
</item>
<item>
  <title><![CDATA[Legion: Director of Production Engineering]]></title>
  <link>https://weworkremotely.com/job/2</link>
  <description><![CDATA[<p>Run infra</p>]]></description>
  <pubDate>Tue, 08 Sep 2026 09:00:00 +0000</pubDate>
</item>
<item><title>No link item</title></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("extracts items, skips ones without link, handles CDATA", () => {
    const items = parseRssItems(SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Veracode: Principal Account Executive",
      link: "https://weworkremotely.com/job/1",
    });
    expect(items[1].title).toBe("Legion: Director of Production Engineering");
  });
  it("pubDate parses to a valid timestamp", () => {
    const items = parseRssItems(SAMPLE);
    expect(new Date(items[0].pubDate!).getTime()).not.toBeNaN();
  });
});

describe("splitCompanyTitle", () => {
  it("splits on first colon", () => {
    expect(splitCompanyTitle("Veracode: Principal AE: EMEA")).toEqual({
      company: "Veracode",
      title: "Principal AE: EMEA",
    });
  });
  it("no colon → Unknown company", () => {
    expect(splitCompanyTitle("Just a title")).toEqual({ company: "Unknown", title: "Just a title" });
  });
});
