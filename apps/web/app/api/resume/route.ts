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
            content:
              'Extract fields and skills from this resume. Reply ONLY JSON: {"fields":[...],"skills":[...]}.',
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
