import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface RemoteOkJob {
  slug?: string; position?: string; company?: string; location?: string;
  salary_min?: number; salary_max?: number; url?: string; date?: string; description?: string;
}

export const parseRemoteOK: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://remoteok.com/api", fetchFn)) as RemoteOkJob[];
  return Promise.all(body
    .filter((j) => j && typeof j === "object" && j.position && j.slug)
    .map((j) =>
      buildJob("remoteok", {
        title: j.position!, company: j.company ?? "Unknown",
        url: j.url ?? `https://remoteok.com/remote-jobs/${j.slug}`,
        location: j.location, salary: j.salary_min ? `$${j.salary_min}-$${j.salary_max}` : null,
        postedAt: j.date ? new Date(j.date).getTime() : null, description: j.description,
      })));
};
