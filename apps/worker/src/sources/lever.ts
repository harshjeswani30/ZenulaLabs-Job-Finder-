import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface LeverJob {
  text: string; hostedUrl: string; createdAt?: number; descriptionPlain?: string;
  categories?: { location?: string; commitment?: string };
}

export const parseLever: SourceParser = async (spec, fetchFn): Promise<NormalizedJob[]> => {
  if (!spec.slug) throw new Error("lever: slug required");
  const body = (await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(spec.slug)}?mode=json`, fetchFn)) as LeverJob[];
  return Promise.all(body.map((j) =>
    buildJob(`lever:${spec.slug}`, {
      title: j.text, company: spec.slug, url: j.hostedUrl,
      location: j.categories?.location, postedAt: j.createdAt ?? null,
      description: j.descriptionPlain,
    })));
};
