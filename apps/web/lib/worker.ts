import { cookies } from "next/headers";

const BASE = process.env.WORKER_URL!;
const TOKEN = process.env.WORKER_INTERNAL_TOKEN!;

export const SESSION_COOKIE = "jf_session";

export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!BASE || !TOKEN) {
    throw new Error("WORKER_URL / WORKER_INTERNAL_TOKEN not configured");
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": TOKEN,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Worker ${path} → ${res.status}`);
  return res;
}

/** The browser's session cookie value, if any — set on login/signup, cleared on logout. */
export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** Call a worker route acting as the logged-in user (Bearer session). */
export async function workerUserFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await sessionToken();
  if (!token) throw new SessionError("not signed in");
  return workerFetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

export class SessionError extends Error {}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 3600,
  };
}

export interface SessionUser {
  id: string;
  email: string;
}

/** Resolve the logged-in user via the worker; null when signed out or expired. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = await sessionToken();
  if (!token) return null;
  try {
    const res = await workerFetch("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as SessionUser;
  } catch {
    return null;
  }
}
