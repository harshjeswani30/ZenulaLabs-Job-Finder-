/** Minimal regex-based RSS/Atom item extractor — no dependencies.
 * Handles CDATA, HTML entities are left for snippet() to clean. */

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title") ?? "";
    let link = extractTag(block, "link") ?? "";
    if (!link) {
      // Atom: <link href="..." />
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (href) link = href[1];
    }
    const description = extractTag(block, "description") ?? extractTag(block, "summary") ?? extractTag(block, "content") ?? "";
    const pubDate = extractTag(block, "pubDate") ?? extractTag(block, "updated") ?? extractTag(block, "published");
    if (title && link) items.push({ title, link, description, pubDate });
  }
  return items;
}

/** WWR/BerlinStartupJobs titles are "Company: Job Title" — split them. */
export function splitCompanyTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(":");
  if (idx > 0 && idx < 80) {
    return { company: raw.slice(0, idx).trim(), title: raw.slice(idx + 1).trim() };
  }
  return { company: "Unknown", title: raw.trim() };
}
