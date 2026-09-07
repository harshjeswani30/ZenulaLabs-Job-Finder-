import { describe, it, expect, vi } from "vitest";
import { parseTheMuse, parseHimalayas, parseJobicy, parseLandingJobs } from "../src/sources/boardApis";

function jsonFetch(body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("themuse parser", () => {
  it("normalizes results", async () => {
    const jobs = await parseTheMuse({ type: "themuse" } as never, jsonFetch({
      results: [{
        id: 1, name: "Backend Engineer", company: { name: "Acme" },
        locations: [{ name: "New York" }, { name: "Remote" }],
        refs: { landing_page: "https://www.themuse.com/job/1" },
        publication_date: "2026-09-01T00:00:00Z", contents: "<div>Build APIs</div>",
      }],
    }));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: "Backend Engineer", company: "Acme", location: "New York, Remote", source: "themuse" });
  });
});

describe("himalayas parser", () => {
  it("normalizes with salary + worldwide default location", async () => {
    const jobs = await parseHimalayas({ type: "himalayas" } as never, jsonFetch({
      jobs: [{ title: "Rust Dev", companyName: "Acme", id: 42, applyUrl: "https://acme.com/job/42", minSalary: 90, maxSalary: 120, salaryPeriod: "year", locationRestrictions: [], pubDate: "2026-09-01" }],
    }));
    expect(jobs[0]).toMatchObject({ location: "Worldwide", salary: "90-120 year", source: "himalayas" });
  });
});

describe("jobicy parser", () => {
  it("normalizes with salary currency", async () => {
    const jobs = await parseJobicy({ type: "jobicy" } as never, jsonFetch({
      jobs: [{ url: "https://jobicy.com/job/1", jobTitle: "DevOps", companyName: "Acme", jobGeo: "USA", pubDate: "2026-09-01", salaryMin: 100, salaryMax: 200, salaryCurrency: "USD", jobDescription: "Run k8s" }],
    }));
    expect(jobs[0]).toMatchObject({ title: "DevOps", salary: "100-200 USD", source: "jobicy" });
  });
});

describe("landingjobs parser", () => {
  it("normalizes array response with EUR salary", async () => {
    const jobs = await parseLandingJobs({ type: "landingjobs" } as never, jsonFetch([
      { id: 19066, title: "Senior Dev", company_name: "Acme", remote: true, salary_min: 60, salary_max: 80, published_at: "2026-09-01" },
    ]));
    expect(jobs[0]).toMatchObject({ title: "Senior Dev", location: "Remote", salary: "€60-80", source: "landingjobs" });
  });
});
