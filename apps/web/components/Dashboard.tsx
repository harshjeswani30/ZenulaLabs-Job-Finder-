"use client";

import { useCallback, useEffect, useState } from "react";

interface RunRow {
  id: string;
  user_id: string;
  started_at: number;
  status: string;
  sources_ok: number;
  sources_failed: number;
  jobs_found: number;
  jobs_sent: number;
  error: string | null;
  duration_ms: number;
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function fmtDuration(ms: number): string {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_STYLES: Record<string, string> = {
  ok: "bg-green-100 text-green-800",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-neutral-100 text-neutral-700";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default function Dashboard() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [runState, setRunState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) throw new Error(`Failed to load runs (${res.status})`);
      const body = (await res.json()) as RunRow[];
      setRuns(Array.isArray(body) ? body : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load runs");
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    const t = setInterval(() => void loadRuns(), 60_000);
    return () => clearInterval(t);
  }, [loadRuns]);

  const runNow = async () => {
    setRunState("running");
    setRunMsg(null);
    try {
      const res = await fetch("/api/run-user", { method: "POST" });
      const body = (await res.json()) as { status?: string; jobsSent?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Run failed (${res.status})`);
      setRunState("done");
      setRunMsg(
        `Run ${body.status ?? "done"} — ${body.jobsSent ?? 0} job(s) sent. Telegram check karo!`
      );
      void loadRuns();
    } catch (err) {
      setRunState("error");
      setRunMsg(err instanceof Error ? err.message : "Run failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void runNow()}
          disabled={runState === "running"}
          className="rounded bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {runState === "running" ? "Running…" : "Run now"}
        </button>
        {runMsg && (
          <p className={`text-sm ${runState === "error" ? "text-red-600" : "text-green-700"}`}>
            {runMsg}
          </p>
        )}
      </div>

      {loadError && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {loadError}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-100 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-4 py-2.5">Started</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Sources (ok/failed)</th>
              <th className="px-4 py-2.5">Jobs found</th>
              <th className="px-4 py-2.5">Jobs sent</th>
              <th className="px-4 py-2.5">Duration</th>
              <th className="px-4 py-2.5">Error</th>
            </tr>
          </thead>
          <tbody>
            {runs === null ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-neutral-500">
                  Loading runs…
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-neutral-500">
                  No runs yet — &quot;Run now&quot; dabao ya cron ka wait karo
                </td>
              </tr>
            ) : (
              runs.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtTime(r.started_at)}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    {r.sources_ok}/{r.sources_failed}
                  </td>
                  <td className="px-4 py-2.5">{r.jobs_found}</td>
                  <td className="px-4 py-2.5">{r.jobs_sent}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtDuration(r.duration_ms)}</td>
                  <td className="max-w-[220px] truncate px-4 py-2.5 text-red-600" title={r.error ?? ""}>
                    {r.error ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
