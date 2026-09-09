import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface GhJob {
  title: string; absolute_url: string; updated_at?: string; content?: string;
  location?: { name?: string };
}

function decodeBase64(b64: string): string {
  // Greenhouse historically base64-encodes content=true bodies, but some
  // boards now return HTML-entity text directly — atob() throws on that.
  // Decode only when the value is actually valid base64.
  const cleaned = b64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return b64;
  try {
    const bin = atob(cleaned);
    return decodeURIComponent(Array.from(bin).map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  } catch {
    return b64;
  }
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
