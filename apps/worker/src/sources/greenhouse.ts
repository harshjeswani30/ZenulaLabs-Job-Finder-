import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface GhJob {
  title: string; absolute_url: string; updated_at?: string; content?: string;
  location?: { name?: string };
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  try { return decodeURIComponent(Array.from(bin).map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")); }
  catch { return bin; }
}

export const parseGreenhouse: SourceParser = async (spec, fetchFn): Promise<NormalizedJob[]> => {
  if (!spec.slug) throw new Error("greenhouse: slug required");
  const slug: string = spec.slug;
  const body = (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`, fetchFn)) as { jobs?: GhJob[] };
  return Promise.all((body.jobs ?? []).map((j) =>
    buildJob(`greenhouse:${slug}`, {
      title: j.title, company: slug, url: j.absolute_url,
      location: j.location?.name, postedAt: j.updated_at ? new Date(j.updated_at).getTime() : null,
      description: j.content ? decodeBase64(j.content) : "",
    })));
};
