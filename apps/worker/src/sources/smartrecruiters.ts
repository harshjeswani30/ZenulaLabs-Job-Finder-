import type { NormalizedJob } from "@jobfinder/shared";
import { buildJob, fetchJson, type SourceParser } from "./types";

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; country?: string };
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: string;
}

export const parseSmartRecruiters: SourceParser = async (spec, fetchFn): Promise<NormalizedJob[]> => {
  if (!spec.slug) throw new Error("smartrecruiters: slug required");
  const slug: string = spec.slug;
  const body = (await fetchJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=50`,
    fetchFn
  )) as { content?: SrPosting[] };
  return Promise.all((body.content ?? []).map((p) =>
    buildJob(`smartrecruiters:${slug}`, {
      title: p.name,
      company: slug,
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${p.id}`,
      location: p.location?.fullLocation ?? ([p.location?.city, p.location?.country].filter(Boolean).join(", ") || null),
      postedAt: p.releasedDate ? new Date(p.releasedDate).getTime() : null,
      description: `${p.department?.label ?? p.function?.label ?? ""} ${p.typeOfEmployment ?? ""}`.trim(),
    })));
};
