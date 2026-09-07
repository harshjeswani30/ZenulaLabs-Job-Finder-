import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { chatId?: string };
    if (!body.chatId || typeof body.chatId !== "string") {
      return Response.json({ error: "chatId required" }, { status: 400 });
    }
    const r = await workerFetch("/telegram-test", {
      method: "POST",
      body: JSON.stringify({ chatId: body.chatId }),
    });
    return Response.json(await r.json());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "worker error" }, { status: 502 });
  }
}
