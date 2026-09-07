"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SiteSpec {
  type:
    | "remotive" | "arbeitnow" | "remoteok"
    | "themuse" | "himalayas" | "jobicy" | "landingjobs"
    | "weworkremotely" | "berlinstartupjobs"
    | "greenhouse" | "lever" | "smartrecruiters";
  slug?: string;
}

interface Config {
  fields: string[];
  skills: string[];
  sites: SiteSpec[];
  filters: { rotateBoards?: { enabled?: boolean; count?: number } };
  scoreThreshold: number;
  cadenceHours: number;
  telegramChatId: string | null;
  isActive: boolean;
}

const SIMPLE_SITES: { type: SiteSpec["type"]; label: string }[] = [
  { type: "remotive", label: "Remotive" },
  { type: "arbeitnow", label: "Arbeitnow" },
  { type: "remoteok", label: "RemoteOK" },
  { type: "themuse", label: "The Muse" },
  { type: "himalayas", label: "Himalayas" },
  { type: "jobicy", label: "Jobicy" },
  { type: "landingjobs", label: "LandingJobs" },
  { type: "weworkremotely", label: "We Work Remotely" },
  { type: "berlinstartupjobs", label: "Berlin Startup Jobs" },
];

const CADENCE_OPTIONS = [1, 2, 3, 6, 12, 24];

function Chip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-neutral-200 px-3 py-1 text-sm">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="text-neutral-500 hover:text-neutral-900"
      >
        &times;
      </button>
    </span>
  );
}

function ChipEditor({
  items,
  onChange,
  placeholder,
  inputId,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  inputId: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (v && !items.some((i) => i.toLowerCase() === v.toLowerCase())) {
      onChange([...items, v]);
    }
    setDraft("");
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        {items.map((item) => (
          <Chip
            key={item}
            label={item}
            onRemove={() => onChange(items.filter((i) => i !== item))}
          />
        ))}
      </div>
      <input
        id={inputId}
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        className="w-full max-w-md rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
      />
    </div>
  );
}

export default function ConfigForm() {
  const [fields, setFields] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [sites, setSites] = useState<SiteSpec[]>([]);
  const [rotateBoards, setRotateBoards] = useState(false);
  const [rotateCount, setRotateCount] = useState(20);
  const [scoreThreshold, setScoreThreshold] = useState(70);
  const [cadenceHours, setCadenceHours] = useState(1);
  const [chatId, setChatId] = useState("");
  const [isActive, setIsActive] = useState(true);

  const [boardType, setBoardType] = useState<"greenhouse" | "lever" | "smartrecruiters">("greenhouse");
  const [boardSlug, setBoardSlug] = useState("");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const [resumeState, setResumeState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
      const cfg = (await res.json()) as Config;
      setFields(cfg.fields ?? []);
      setSkills(cfg.skills ?? []);
      setSites(cfg.sites ?? []);
      setRotateBoards(cfg.filters?.rotateBoards?.enabled ?? false);
      setRotateCount(cfg.filters?.rotateBoards?.count ?? 20);
      setScoreThreshold(cfg.scoreThreshold ?? 70);
      setCadenceHours(cfg.cadenceHours ?? 1);
      setChatId(cfg.telegramChatId ?? "");
      setIsActive(cfg.isActive ?? true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const toggleSimpleSite = (type: SiteSpec["type"], checked: boolean) => {
    setSites((prev) =>
      checked
        ? [...prev, { type }]
        : prev.filter((s) => !(s.type === type && !s.slug))
    );
  };

  const addBoard = () => {
    const slug = boardSlug.trim();
    if (!slug) return;
    if (sites.some((s) => s.type === boardType && s.slug === slug)) {
      setBoardSlug("");
      return;
    }
    setSites((prev) => [...prev, { type: boardType, slug }]);
    setBoardSlug("");
  };

  const uploadResume = async (file: File) => {
    setResumeState("uploading");
    setResumeMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: fd });
      const body = (await res.json()) as { fields?: string[]; skills?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
      const newFields = (body.fields ?? []).filter(
        (f) => f && !fields.some((x) => x.toLowerCase() === f.toLowerCase())
      );
      const newSkills = (body.skills ?? []).filter(
        (s) => s && !skills.some((x) => x.toLowerCase() === s.toLowerCase())
      );
      if (newFields.length) setFields((prev) => [...prev, ...newFields]);
      if (newSkills.length) setSkills((prev) => [...prev, ...newSkills]);
      setResumeState("done");
      setResumeMsg(
        newFields.length + newSkills.length
          ? `Added ${newFields.length} fields, ${newSkills.length} skills from resume`
          : "Resume parsed, but nothing new to add"
      );
    } catch (err) {
      setResumeState("error");
      setResumeMsg(err instanceof Error ? err.message : "Resume parse failed");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const sendTest = async () => {
    if (!chatId.trim()) {
      setTestState("error");
      setTestMsg("Chat ID pehle daalo");
      return;
    }
    setTestState("sending");
    setTestMsg(null);
    try {
      const res = await fetch("/api/telegram-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: chatId.trim() }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? "Test message failed");
      setTestState("sent");
      setTestMsg("Test message sent — Telegram check karo!");
    } catch (err) {
      setTestState("error");
      setTestMsg(err instanceof Error ? err.message : "Test message failed");
    }
  };

  const save = async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "owner",
          fields,
          skills,
          sites,
          filters: { rotateBoards: { enabled: rotateBoards, count: rotateCount } },
          scoreThreshold,
          cadenceHours,
          isActive,
          telegramChatId: chatId.trim() || null,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `Save failed (${res.status})`);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  };

  if (loading) {
    return <p className="text-neutral-500">Loading config…</p>;
  }

  if (loadError) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-4">
        <p className="text-red-700">{loadError}</p>
        <button
          type="button"
          onClick={() => void loadConfig()}
          className="mt-2 rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Fields */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Job fields</h3>
        <p className="mb-2 text-sm text-neutral-500">
          e.g. Frontend, Data Engineering, DevOps
        </p>
        <ChipEditor
          items={fields}
          onChange={setFields}
          placeholder="Type a field and press Enter"
          inputId="field-input"
        />
      </section>

      {/* Skills */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Skills</h3>
        <p className="mb-2 text-sm text-neutral-500">
          e.g. React, TypeScript, SQL
        </p>
        <ChipEditor
          items={skills}
          onChange={setSkills}
          placeholder="Type a skill and press Enter"
          inputId="skill-input"
        />
      </section>

      {/* Resume upload */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Resume</h3>
        <p className="mb-2 text-sm text-neutral-500">
          PDF upload karo — fields aur skills automatically extract honge
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadResume(f);
          }}
          disabled={resumeState === "uploading"}
          className="block text-sm"
        />
        {resumeState === "uploading" && (
          <p className="mt-2 text-sm text-neutral-500">Parsing resume…</p>
        )}
        {resumeMsg && (
          <p
            className={`mt-2 text-sm ${
              resumeState === "error" ? "text-red-600" : "text-green-700"
            }`}
          >
            {resumeMsg}
          </p>
        )}
      </section>

      {/* Sites */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Job sites</h3>
        <p className="mb-2 text-sm text-neutral-500">
          Free job boards to scrape each run
        </p>
        <div className="space-y-2">
          {SIMPLE_SITES.map(({ type, label }) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sites.some((s) => s.type === type && !s.slug)}
                onChange={(e) => toggleSimpleSite(type, e.target.checked)}
                className="h-4 w-4"
              />
              {label}
            </label>
          ))}
        </div>

        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">Company boards (Greenhouse / Lever / SmartRecruiters)</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={boardType}
              onChange={(e) => setBoardType(e.target.value as "greenhouse" | "lever" | "smartrecruiters")}
              className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
              <option value="smartrecruiters">SmartRecruiters</option>
            </select>
            <input
              type="text"
              value={boardSlug}
              placeholder="company slug (e.g. stripe)"
              onChange={(e) => setBoardSlug(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addBoard();
                }
              }}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={addBoard}
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Add board
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {sites
              .filter((s) => s.slug)
              .map((s) => (
                <Chip
                  key={`${s.type}:${s.slug}`}
                  label={`${s.type}:${s.slug}`}
                  onRemove={() =>
                    setSites((prev) => prev.filter((x) => !(x.type === s.type && x.slug === s.slug)))
                  }
                />
              ))}
          </div>
        </div>

        <div className="mt-4 rounded border border-neutral-200 bg-neutral-50 p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rotateBoards}
              onChange={(e) => setRotateBoards(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="font-medium">Auto-rotate company boards</span>
          </label>
          <p className="mt-1 mb-2 text-sm text-neutral-500">
            Har run me 1205-company catalog se alag companies check hoti he — poora catalog ~2.5 din me cover ho jata he
          </p>
          {rotateBoards && (
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="rotate-count" className="text-neutral-600">
                Companies per run:
              </label>
              <input
                id="rotate-count"
                type="number"
                min={1}
                max={20}
                value={rotateCount}
                onChange={(e) => setRotateCount(Math.max(1, Math.min(20, Number(e.target.value))))}
                className="w-20 rounded border border-neutral-300 bg-white px-2 py-1"
              />
              <span className="text-neutral-400">(1–20)</span>
            </div>
          )}
        </div>
      </section>

      {/* Score threshold + cadence */}
      <section className="flex flex-wrap gap-8">
        <div>
          <h3 className="mb-1 text-sm font-semibold">Score threshold</h3>
          <p className="mb-2 text-sm text-neutral-500">
            Jobs scoring at least this get sent (0–100)
          </p>
          <input
            type="number"
            min={0}
            max={100}
            value={scoreThreshold}
            onChange={(e) => setScoreThreshold(Number(e.target.value))}
            className="w-24 rounded border border-neutral-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Check frequency</h3>
          <p className="mb-2 text-sm text-neutral-500">Kitni der mein naye jobs check hon</p>
          <select
            value={cadenceHours}
            onChange={(e) => setCadenceHours(Number(e.target.value))}
            className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm"
          >
            {CADENCE_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h === 1 ? "Every hour" : `Every ${h} hours`}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Telegram */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Telegram chat ID</h3>
        <p className="mb-2 text-sm text-neutral-500">
          @userinfobot se apna chat ID lo, phir yahan paste karo
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={chatId}
            placeholder="e.g. 123456789"
            onChange={(e) => setChatId(e.target.value)}
            className="w-56 rounded border border-neutral-300 bg-white px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testState === "sending"}
            className="rounded border border-neutral-400 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
          >
            {testState === "sending" ? "Sending…" : "Send test"}
          </button>
        </div>
        {testMsg && (
          <p
            className={`mt-2 text-sm ${
              testState === "error" ? "text-red-600" : "text-green-700"
            }`}
          >
            {testMsg}
          </p>
        )}
      </section>

      {/* Active toggle */}
      <section>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="font-medium">Active</span>
          <span className="text-neutral-500">
            (band karo to cron runs skip honge)
          </span>
        </label>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3 border-t border-neutral-200 pt-4">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saveState === "saving"}
          className="rounded bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {saveState === "saving" ? "Saving…" : "Save config"}
        </button>
        {saveState === "saved" && <p className="text-sm text-green-700">Saved ✓</p>}
        {saveState === "error" && saveError && (
          <p className="text-sm text-red-600">{saveError}</p>
        )}
      </div>
    </div>
  );
}
