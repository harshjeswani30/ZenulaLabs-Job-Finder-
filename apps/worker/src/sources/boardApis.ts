import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

// --- TheMuse ---
interface MuseJob {
  id: number;
  name: string;
  company?: { name?: string };
  locations?: { name?: string }[];
  refs?: { landing_page?: string };
  publication_date?: string;
  contents?: string;
}

export const parseTheMuse: SourceParser = async (spec, fetchFn): Promise<NormalizedJob[]> => {
  const page = spec.query ? encodeURIComponent(spec.query) : "1";
  const body = (await fetchJson(`https://www.themuse.com/api/public/jobs?page=${page}`, fetchFn)) as { results?: MuseJob[] };
  return Promise.all((body.results ?? []).map((j) =>
    buildJob("themuse", {
      title: j.name,
      company: j.company?.name ?? "Unknown",
      url: j.refs?.landing_page ?? `https://www.themuse.com/jobs/${j.id}`,
      location: (j.locations ?? []).map((l) => l.name).filter(Boolean).join(", ") || null,
      postedAt: j.publication_date ? new Date(j.publication_date).getTime() : null,
      description: j.contents ?? "",
    })));
};

// --- Himalayas ---
interface HimalayasJob {
  title: string;
  companyName: string;
  companySlug?: string;
  guid?: string;
  id?: number;
  applyUrl?: string;
  pubDate?: string;
  excerpt?: string;
  minSalary?: number;
  maxSalary?: number;
  salaryPeriod?: string;
  locationRestrictions?: string[];
}

export const parseHimalayas: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://himalayas.app/jobs/api", fetchFn)) as { jobs?: HimalayasJob[] };
  return Promise.all((body.jobs ?? []).map((j) =>
    buildJob("himalayas", {
      title: j.title,
      company: j.companyName,
      url: j.applyUrl ?? (j.id ? `https://himalayas.app/jobs/${j.id}` : `https://himalayas.app/companies/${j.companySlug ?? j.companyName}`),
      location: (j.locationRestrictions ?? []).join(", ") || "Worldwide",
      salary: j.minSalary && j.maxSalary ? `${j.minSalary}-${j.maxSalary} ${j.salaryPeriod ?? ""}`.trim() : null,
      postedAt: j.pubDate ? new Date(j.pubDate).getTime() : null,
      description: j.excerpt ?? "",
    })));
};

// --- Jobicy ---
interface JobicyJob {
  url: string;
  jobTitle: string;
  companyName: string;
  jobGeo: string;
  pubDate: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  jobDescription: string;
}

export const parseJobicy: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://jobicy.com/api/v2/remote-jobs", fetchFn)) as { jobs?: JobicyJob[] };
  return Promise.all((body.jobs ?? []).map((j) =>
    buildJob("jobicy", {
      title: j.jobTitle,
      company: j.companyName,
      url: j.url,
      location: j.jobGeo,
      salary: j.salaryMin != null && j.salaryMax != null ? `${j.salaryMin}-${j.salaryMax} ${j.salaryCurrency ?? ""}`.trim() : null,
      postedAt: j.pubDate ? new Date(j.pubDate).getTime() : null,
      description: j.jobDescription,
    })));
};

// --- Landing.jobs ---
interface LandingJob {
  id: number;
  title?: string;
  company_name?: string;
  remote?: boolean;
  salary_min?: number;
  salary_max?: number;
  published_at?: string;
  description?: string;
}

export const parseLandingJobs: SourceParser = async (_spec, fetchFn): Promise<NormalizedJob[]> => {
  const body = (await fetchJson("https://landing.jobs/api/v1/jobs", fetchFn)) as LandingJob[];
  return Promise.all(body.map((j) =>
    buildJob("landingjobs", {
      title: j.title ?? "Untitled",
      company: j.company_name ?? "Unknown",
      url: `https://landing.jobs/jobs/${j.id}`,
      location: j.remote ? "Remote" : null,
      salary: j.salary_min != null && j.salary_max != null ? `€${j.salary_min}-${j.salary_max}` : null,
      postedAt: j.published_at ? new Date(j.published_at).getTime() : null,
      description: j.description ?? "",
    })));
};
