const BASE = process.env.WORKER_URL!;
const TOKEN = process.env.WORKER_INTERNAL_TOKEN!;

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
