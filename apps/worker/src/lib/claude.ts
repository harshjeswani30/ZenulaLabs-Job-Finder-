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
      max_tokens: 2000,
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
  const system = "Extract the candidate's job fields (e.g. 'Frontend', 'Data Engineering') and skills (technologies/tools) from a resume. " +
    "Respond with ONLY JSON: {\"fields\":[...],\"skills\":[...]}.";
  const text = await callLlm(apiKey, system, resumeText.slice(0, 15000), fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { fields?: string[]; skills?: string[] };
  return { fields: (parsed.fields ?? []).map(String).slice(0, 8), skills: (parsed.skills ?? []).map(String).slice(0, 25) };
}
