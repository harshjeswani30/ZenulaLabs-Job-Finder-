import type { NormalizedJob } from "@jobfinder/shared";

const MODEL = "openai/gpt-oss-120b";
const API = "https://api.groq.com/openai/v1/chat/completions";

async function callLlm(apiKey: string, system: string, user: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(API, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`, "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      // gpt-oss is a reasoning model — without "low" it burns most of a small
      // token budget on hidden thinking, truncating the actual JSON output.
      reasoning_effort: "low",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("LLM returned no text");
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
  const text = await callLlm(apiKey, system, user, fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { hash: string; score: number }[];
  const map = new Map<string, number>();
  for (const p of parsed) map.set(p.hash, Math.max(0, Math.min(100, Math.round(p.score))));
  return map;
}

export async function parseResumeText(
  apiKey: string, resumeText: string, fetchFn: typeof fetch
): Promise<{ fields: string[]; skills: string[] }> {
  const system = [
    "You are an exhaustive resume parser for a job-matching engine. Your output is the candidate's matching profile — missing an item means missed job matches, so capture EVERYTHING technical.",
    "Sweep the ENTIRE document line by line: summary, experience bullets, project descriptions, and any skills/tech sections.",
    '"fields": 3-10 job categories this person could be hired for. Short canonical title terms: "Full Stack", "Frontend", "Backend", "DevOps", "Data Engineering", "Data Analyst", "Machine Learning", "Mobile Development", "QA Engineering", "Site Reliability".',
    '"skills": EVERY concrete technology, language, framework, library, database, cloud platform, and tool the candidate has used. Expect 30-60 items for a typical professional resume. Include items from skills sections AND items evidenced in experience/project bullets.',
    "Rules:",
    '- Canonical names: "PostgreSQL" not "postgres db"; "AWS" not "Amazon Web Services". Cloud services stay specific: "AWS Lambda", "AWS ECS" (not just AWS if specific services are mentioned).',
    "- Include adjacent-but-real items: CI/CD tools (GitHub Actions), test frameworks (Vitest, Playwright), package/infra tools (Wrangler, Docker Compose), protocols (REST APIs, tRPC) when actually used.",
    '- EXCLUDE: soft skills (communication, leadership), certifications, education, experience counts ("5 years"), and generic buzzwords (Agile, Scrum) unless tooling-related.',
    "- Keep each item 1-4 words, Title Case, no duplicates.",
    '- NEVER invent skills that are not in the document. A sparse resume yields few skills — do not pad.',
    'Reply with ONLY this JSON, no markdown, no explanation: {"fields": ["..."], "skills": ["..."]}',
  ].join("\n");
  const text = await callLlm(apiKey, system, resumeText.slice(0, 15000), fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { fields?: string[]; skills?: string[] };
  return { fields: (parsed.fields ?? []).map(String).slice(0, 10), skills: (parsed.skills ?? []).map(String).slice(0, 60) };
}
