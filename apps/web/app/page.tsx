"use client";

import { useState } from "react";
import ConfigForm from "@/components/ConfigForm";
import Dashboard from "@/components/Dashboard";

type Tab = "setup" | "dashboard";

export default function Home() {
  const [tab, setTab] = useState<Tab>("setup");

  const tabCls = (active: boolean) =>
    `rounded px-4 py-2 text-sm font-medium ${
      active
        ? "bg-neutral-900 text-white"
        : "text-neutral-600 hover:bg-neutral-200"
    }`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-bold">Job Finder</h1>

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
