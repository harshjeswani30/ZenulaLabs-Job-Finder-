import type { JobSourceSpec, NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface RemotiveJob {
  url: string; title: string; company_name: string; candidate_required_location?: string;
  salary?: string; publication_date?: string; description?: string;
}

export const parseRemotive: SourceParser = async (spec: JobSourceSpec, fetchFn): Promise<NormalizedJob[]> => {
  const base = "https://remotive.com/api/remote-jobs?limit=50";
  const url = spec.query ? `${base}&search=${encodeURIComponent(spec.query)}` : base;
  const body = (await fetchJson(url, fetchFn)) as { jobs?: RemotiveJob[] };
  return Promise.all((body.jobs ?? []).map((j) =>
    buildJob("remotive", {
      title: j.title, company: j.company_name, url: j.url,
      location: j.candidate_required_location, salary: j.salary,
      postedAt: j.publication_date ? new Date(j.publication_date).getTime() : null,
      description: j.description,
    })));
};
