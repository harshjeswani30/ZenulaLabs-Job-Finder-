import type { JobSourceSpec, NormalizedJob } from "@jobfinder/shared";
import { makeJobHash, snippet } from "../lib/hash";

export type SourceParser = (spec: JobSourceSpec, fetchFn: typeof fetch) => Promise<NormalizedJob[]>;

export async function buildJob(
  source: string,
  raw: { title: string; company: string; url: string; location?: string | null; salary?: string | null; postedAt?: number | null; description?: string }
): Promise<NormalizedJob> {
  return {
    hash: await makeJobHash(source, raw.title, raw.company, raw.url),
    title: raw.title.trim(),
    company: raw.company.trim(),
    location: raw.location?.trim() || null,
    salary: raw.salary?.trim() || null,
    url: raw.url.trim(),
    source,
    descriptionSnippet: snippet(raw.description ?? ""),
    postedAt: raw.postedAt ?? null,
  };
}

export async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: { "user-agent": "JobFinderBot/0.1 (personal; contact: owner)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}
