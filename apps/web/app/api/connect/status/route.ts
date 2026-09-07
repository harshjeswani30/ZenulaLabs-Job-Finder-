import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return Response.json({ error: "token required" }, { status: 400 });
  }
  try {
    const r = await workerFetch(`/bot/status/${encodeURIComponent(token)}`);
    return Response.json(await r.json());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "status check failed" }, { status: 502 });
  }
}
