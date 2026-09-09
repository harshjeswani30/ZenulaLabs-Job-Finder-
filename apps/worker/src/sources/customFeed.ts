import type { JobSourceSpec } from "@jobfinder/shared";
import { buildJob, type SourceParser } from "./types";
import { parseRssItems } from "./rss";

/** Custom user-supplied job feed: any RSS/Atom URL added via the web UI.
 * spec.query holds the feed URL; spec.slug holds a display label (optional). */

const FEED_HEADERS = { "user-agent": "JobFinderBot/0.1 (personal; contact: owner)" };

export function isValidCustomFeedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

export const parseCustomFeed: SourceParser = async (
  spec: JobSourceSpec,
  fetchFn: typeof fetch
) => {
  const url = spec.query?.trim();
  if (!url || !isValidCustomFeedUrl(url)) {
    throw new Error(`custom feed: missing or invalid URL (got "${url ?? ""}")`);
  }
  const res = await fetchFn(url, { headers: FEED_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const xml = await res.text();

  const items = parseRssItems(xml);
  const label = spec.slug?.trim() || hostLabel(url);
  return Promise.all(items.map((it) =>
    buildJob(`custom:${label}`, {
      title: it.title,
      company: label,
      url: it.link,
      location: null,
      postedAt: it.pubDate ? new Date(it.pubDate).getTime() : null,
      description: it.description,
    })
  ));
};

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "custom";
  }
}
