import { NextResponse } from "next/server";
import { workerFetch, SESSION_COOKIE, sessionCookieOptions } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await workerFetch("/auth/signup", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { error?: string };
      return Response.json({ error: err.error ?? "signup failed" }, { status: r.status });
    }
    const { token, user } = (await r.json()) as { token: string; user: { id: string; email: string } };
    const res = NextResponse.json({ user });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "signup failed" }, { status: 502 });
  }
}
