import pdfParse from "pdf-parse";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "no file" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buf);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "GROQ_API_KEY not configured" }, { status: 500 });
    }

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        max_tokens: 4000,
        // gpt-oss is a reasoning model — without "low" it burns ~600-750 of a
        // 1000-token budget on hidden thinking, truncating the actual JSON.
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
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
            ].join("\n"),
          },
          { role: "user", content: parsed.text.slice(0, 15000) },
        ],
      }),
    });
    if (!res.ok) {
      return Response.json({ error: `Groq API ${res.status}` }, { status: 502 });
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? "{}";
    const out = JSON.parse(text.replace(/```json|```/g, "").trim()) as {
      fields?: unknown;
      skills?: unknown;
    };
    return Response.json({
      fields: Array.isArray(out.fields) ? out.fields.map(String).slice(0, 10) : [],
      skills: Array.isArray(out.skills) ? out.skills.map(String).slice(0, 60) : [],
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "resume parse failed" },
      { status: 500 }
    );
  }
}
