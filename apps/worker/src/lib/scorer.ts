import type { NormalizedJob, ScoredJob, UserConfig } from "@jobfinder/shared";
import { scoreJobsBatch } from "./claude";

export function keywordScore(profile: { skills: string[] }, job: NormalizedJob): number {
  const hay = `${job.title} ${job.descriptionSnippet}`.toLowerCase();
  const hits = profile.skills.filter((s) => hay.includes(s.toLowerCase())).length;
  return hits >= 2 ? 90 : hits === 1 ? 75 : 0;
}

export async function scoreJobs(
  apiKey: string,
  profile: { fields: string[]; skills: string[] },
  jobs: NormalizedJob[],
  fetchFn: typeof fetch
): Promise<ScoredJob[]> {
  if (jobs.length === 0) return [];
  const out: ScoredJob[] = [];
  for (let i = 0; i < jobs.length; i += 25) {
    const chunk = jobs.slice(i, i + 25);
    try {
      const map = await scoreJobsBatch(apiKey, profile, chunk, fetchFn);
      for (const j of chunk) out.push({ job: j, score: map.get(j.hash) ?? keywordScore(profile, j) });
    } catch {
      for (const j of chunk) out.push({ job: j, score: keywordScore(profile, j) });
    }
  }
  return out;
}

export interface ScoringProfile { fields: string[]; skills: string[]; }
export type { UserConfig };
