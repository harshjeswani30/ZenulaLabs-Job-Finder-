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
        max_tokens: 1000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a precise resume parser for a job-matching engine. Extract the candidate's professional identity as two lists.",
              '"fields" = job categories this person works in (2-5 items). Short, canonical, as they appear in job titles. Examples: "Full Stack", "Frontend", "Backend", "Data Engineering", "Data Analyst", "DevOps", "Machine Learning", "Mobile Development", "QA Engineering".',
              '"skills" = concrete technologies, tools, languages, and frameworks the candidate has actually used (10-25 items). Examples: "React", "TypeScript", "Node.js", "Python", "SQL", "PostgreSQL", "Docker", "AWS", "Tailwind CSS", "Next.js", "FastAPI".',
              "Rules:",
              "- Use the most standard name for each item (write \"PostgreSQL\", not \"postgres db\"; \"AWS\", not \"Amazon Web Services\").",
              "- Include a skill only if the resume shows evidence of using it (in projects, work experience, or a skills section) — not merely because it appears in a job title.",
              "- Exclude soft skills (communication, leadership, teamwork), certifications, education, and experience claims (\"5 years\").",
              "- Keep each item 1-3 words, Title Case.",
              "- If the resume is ambiguous, prefer what the candidate emphasizes most (recent, repeated, or prominent).",
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
      fields: Array.isArray(out.fields) ? out.fields.map(String).slice(0, 8) : [],
      skills: Array.isArray(out.skills) ? out.skills.map(String).slice(0, 25) : [],
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "resume parse failed" },
      { status: 500 }
    );
  }
}
