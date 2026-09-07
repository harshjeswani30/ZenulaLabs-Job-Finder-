import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await workerFetch("/runs?limit=20");
    return Response.json(await r.json());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "worker error" }, { status: 502 });
  }
}
