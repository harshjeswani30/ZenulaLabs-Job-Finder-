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
    "You are an exhaustive resume parser for a job-matching engine. Your output is the candidate's matching profile — missing an item means missed job matches, so capture EVERYTHING that could match a job posting.",
    "Sweep the ENTIRE document line by line: summary, experience bullets, project descriptions, and skills sections.",
    '"fields": 3-10 job categories/roles this person could genuinely be hired for, based on what the resume actually shows. You decide the right vocabulary for THIS candidate — a software engineer yields "Frontend", "Backend"; an AI annotator yields "Data Annotation", "Content Moderation", "AI Evaluation"; a designer yields "UI Design". Do not force tech categories onto non-tech resumes, and vice versa.',
    '"skills": EVERY concrete capability the candidate has that a job posting would list as a requirement — technologies, tools, platforms, languages (including human languages at stated proficiency), methodologies, and specific domain expertise. For a typical resume expect 20-50 items; for a non-engineering resume, transferable evaluation/annotation/editorial skills ARE skills (e.g. "Data Annotation", "Quality Assurance", "Content Review", "Pairwise Comparison", "Reading Comprehension").',
    "Rules:",
    "- YOU decide what counts as a skill for this candidate — extract what is actually there, not what a template says.",
    "- Canonical names, Title Case, 1-5 words each, no duplicates.",
    '- Include human languages with level when stated: "Hindi (Native)", "English (C1-C2)".',
    "- Include tools/platforms named anywhere (OpenAI API, PostgreSQL, Figma...) and certifications' subject areas as skills (e.g. NPTEL Cloud/IoT/ML course → \"Cloud Computing\", \"IoT\", \"Machine Learning\").",
    "- ONLY exclude: pure personality traits with no job-posting equivalent (e.g. \"Self-Motivated\", \"Reliable\"), education institution names, and experience counts (\"5 years\").",
    "- NEVER invent anything not in the document; but DO rephrase resume phrasing into terms job postings use (\"Keen Eye for Detail\" → \"Attention to Detail\", \"Willingness to Learn New Platforms\" → \"Fast Learning\").",
    'Reply with ONLY this JSON, no markdown, no explanation: {"fields": ["..."], "skills": ["..."]}',
  ].join("\n");
  const text = await callLlm(apiKey, system, resumeText.slice(0, 15000), fetchFn);
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { fields?: string[]; skills?: string[] };
  return { fields: (parsed.fields ?? []).map(String).slice(0, 10), skills: (parsed.skills ?? []).map(String).slice(0, 60) };
}
