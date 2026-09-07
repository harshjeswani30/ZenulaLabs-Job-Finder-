import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const r = await workerFetch("/bot/connect", { method: "POST" });
    return Response.json(await r.json());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "connect failed" }, { status: 502 });
  }
}
