import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface ArbeitnowJob {
  url: string; title: string; company_name: string; location?: string;
  description?: string; created_at?: number; remote?: boolean;
}

export const parseArbeitnow: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://www.arbeitnow.com/api/job-board-api", fetchFn)) as { data?: ArbeitnowJob[] };
  return Promise.all((body.data ?? []).map((j) =>
    buildJob("arbeitnow", {
      title: j.title, company: j.company_name, url: j.url,
      location: j.remote ? "Remote" : j.location, postedAt: j.created_at ? j.created_at * 1000 : null,
      description: j.description,
    })));
};
