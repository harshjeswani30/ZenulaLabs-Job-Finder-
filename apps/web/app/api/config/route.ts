import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await workerFetch("/config");
    return Response.json(await r.json());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "worker error" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await workerFetch("/config", { method: "POST", body: JSON.stringify(body) });
    return Response.json(await r.json());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "worker error" }, { status: 502 });
  }
}
