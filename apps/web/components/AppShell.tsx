"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfigForm from "./ConfigForm";
import Dashboard from "./Dashboard";

type Tab = "setup" | "dashboard";

export default function AppShell({ email }: { email: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("setup");

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const tabCls = (active: boolean) =>
    `rounded px-4 py-2 text-sm font-medium ${
      active ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-200"
    }`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Job Finder</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-500">{email}</span>
          <button
            type="button"
            onClick={logout}
            className="rounded border border-neutral-300 px-3 py-1.5 text-neutral-600 hover:bg-neutral-100"
          >
            Log out
          </button>
        </div>
      </div>

      <div className="mb-8 inline-flex gap-1 rounded-lg bg-neutral-200 p-1">
        <button type="button" className={tabCls(tab === "setup")} onClick={() => setTab("setup")}>
          Setup
        </button>
        <button
          type="button"
          className={tabCls(tab === "dashboard")}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
      </div>

      {tab === "setup" ? <ConfigForm /> : <Dashboard />}
    </main>
  );
}
