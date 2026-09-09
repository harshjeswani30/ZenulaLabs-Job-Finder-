import { workerUserFetch, SessionError } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const r = await workerUserFetch("/run-user", { method: "POST" });
    return Response.json(await r.json());
  } catch (err) {
    if (err instanceof SessionError) return Response.json({ error: "not signed in" }, { status: 401 });
    return Response.json({ error: err instanceof Error ? err.message : "worker error" }, { status: 502 });
  }
}
