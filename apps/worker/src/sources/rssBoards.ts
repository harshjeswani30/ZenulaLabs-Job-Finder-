import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, type SourceParser } from "./types";
import { parseRssItems, splitCompanyTitle } from "./rss";

async function fetchText(url: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(url, { headers: { "user-agent": "JobFinderBot/0.1 (personal; contact: owner)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

export function rssBoardParser(
  source: string,
  feedUrl: (spec: { query?: string }) => string,
  opts: { splitCompany?: boolean } = {}
): SourceParser {
  return async (spec, fetchFn): Promise<NormalizedJob[]> => {
    const xml = await fetchText(feedUrl(spec), fetchFn);
    const items = parseRssItems(xml);
    return Promise.all(items.map(async (it) => {
      const { company, title } = opts.splitCompany ? splitCompanyTitle(it.title) : { company: "Unknown", title: it.title };
      return buildJob(source, {
        title,
        company,
        url: it.link,
        location: null,
        postedAt: it.pubDate ? new Date(it.pubDate).getTime() : null,
        description: it.description,
      });
    }));
  };
}

export const parseWeWorkRemotely: SourceParser = rssBoardParser(
  "weworkremotely",
  (spec) => spec.query
    ? `https://weworkremotely.com/categories/${encodeURIComponent(spec.query)}.rss`
    : "https://weworkremotely.com/remote-jobs.rss",
  { splitCompany: true }
);

export const parseBerlinStartupJobs: SourceParser = rssBoardParser(
  "berlinstartupjobs",
  () => "https://berlinstartupjobs.com/feed/",
  { splitCompany: true }
);
