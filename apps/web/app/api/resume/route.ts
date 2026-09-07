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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system:
          'Extract fields and skills from this resume. Reply ONLY JSON: {"fields":[...],"skills":[...]}.',
        messages: [{ role: "user", content: parsed.text.slice(0, 15000) }],
      }),
    });
    if (!res.ok) {
      return Response.json({ error: `Claude API ${res.status}` }, { status: 502 });
    }
    const body = (await res.json()) as { content?: { text?: string }[] };
    const text = body.content?.[0]?.text ?? "{}";
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
