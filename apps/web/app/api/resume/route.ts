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
