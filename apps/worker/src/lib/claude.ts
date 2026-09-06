import type { NormalizedJob } from "@jobfinder/shared";

const MODEL = "claude-haiku-4-5-20251001";
const API = "https://api.anthropic.com/v1/messages";

async function callClaude(apiKey: string, system: string, user: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = body.content.find((c) => c.type === "text")?.text ?? "";
  if (!text) throw new Error("Claude returned no text");
  return text;
}

export async function scoreJobsBatch(
  apiKey: string,
  profile: { fields: string[]; skills: string[] },
  jobs: NormalizedJob[],
  fetchFn: typeof fetch
): Promise<Map<string, number>> {
  const system =
    "You are a job-relevance scorer. Given a candidate profile and job postings, score each job 0-100 for fit. " +
    "Respond with ONLY a JSON array like [{\"hash\":\"...\",\"score\":0}] — no markdown, no explanation.";
  const user = JSON.stringify({
    profile: { fields: profile.fields, skills: profile.skills },
    jobs: jobs.map((j) => ({ hash: j.hash, title: j.title, company: j.company, snippet: j.descriptionSnippet.slice(0, 300) })),
  });
  const text = await callClaude(apiKey, system, user, fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { hash: string; score: number }[];
  const map = new Map<string, number>();
  for (const p of parsed) map.set(p.hash, Math.max(0, Math.min(100, Math.round(p.score))));
  return map;
}

export async function parseResumeText(
  apiKey: string, resumeText: string, fetchFn: typeof fetch
): Promise<{ fields: string[]; skills: string[] }> {
  const system = "Extract the candidate's job fields (e.g. 'Frontend', 'Data Engineering') and skills (technologies/tools) from a resume. " +
    "Respond with ONLY JSON: {\"fields\":[...],\"skills\":[...]}.";
  const text = await callClaude(apiKey, system, resumeText.slice(0, 15000), fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { fields?: string[]; skills?: string[] };
  return { fields: (parsed.fields ?? []).map(String).slice(0, 8), skills: (parsed.skills ?? []).map(String).slice(0, 25) };
}
