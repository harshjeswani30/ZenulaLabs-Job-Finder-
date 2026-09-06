export interface NormalizedJob {
  hash: string;            // sha256(source|title|company|url)
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  url: string;
  source: string;          // "remotive" | "arbeitnow" | "remoteok" | "greenhouse:<slug>" | "lever:<slug>"
  descriptionSnippet: string; // first 800 chars, whitespace-collapsed
  postedAt: number | null;  // unix ms
}

export interface UserConfig {
  userId: string;
  fields: string[];
  skills: string[];
  sites: JobSourceSpec[];
  filters: { remoteOnly?: boolean; countries?: string[]; keywords?: string[] };
  scoreThreshold: number;
  cadenceHours: number;
  isActive: boolean;
}

export interface JobSourceSpec {
  type: "remotive" | "arbeitnow" | "remoteok" | "greenhouse" | "lever" | "adzuna";
  slug?: string;      // greenhouse/lever company slug
  query?: string;     // adzuna search terms
}

export interface ScoredJob {
  job: NormalizedJob;
  score: number;      // 0-100
  reason?: string;
}

export interface RunRecord {
  id: string;
  userId: string;
  startedAt: number;
  status: "ok" | "partial" | "failed";
  sourcesOk: number;
  sourcesFailed: number;
  jobsFound: number;
  jobsSent: number;
  error?: string;
  durationMs: number;
}
