import { workerUserFetch, SessionError } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const r = await workerUserFetch("/bot/connect", { method: "POST" });
    return Response.json(await r.json());
  } catch (err) {
    if (err instanceof SessionError) return Response.json({ error: "not signed in" }, { status: 401 });
    return Response.json({ error: err instanceof Error ? err.message : "connect failed" }, { status: 502 });
  }
}
