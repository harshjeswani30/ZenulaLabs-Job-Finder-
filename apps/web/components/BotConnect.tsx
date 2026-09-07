"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Modern bot connect: button → one-time deep link opens Telegram with ?start=<token>;
 * the user taps START, the webhook links their chat, and this component polls
 * until it flips to "Connected as @username".
 */
export default function BotConnect({ onLinked }: { onLinked?: (chatId: string) => void }) {
  const [connectState, setConnectState] = useState<"idle" | "waiting" | "linked" | "error">("idle");
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const connect = async () => {
    setConnectState("waiting");
    setConnectMsg("Telegram khol raha hoon… START dabana wahan, phir wapas aa jana 👀");
    try {
      const res = await fetch("/api/connect/start", { method: "POST" });
      const body = (await res.json()) as { token?: string; link?: string; error?: string };
      if (!res.ok || !body.link || !body.token) {
        throw new Error(body.error ?? "connect failed");
      }
      // open Telegram in a new tab so the user keeps this page polling
      window.open(body.link, "_blank");
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const s = await fetch(`/api/connect/status?token=${encodeURIComponent(body.token!)}`);
          const st = (await s.json()) as { status?: string; telegram_username?: string | null; chat_id?: string | null };
          if (st.status === "linked") {
            stopPolling();
            setConnectState("linked");
            setUsername(st.telegram_username ? `@${st.telegram_username}` : `Chat ${st.chat_id}`);
            setConnectMsg("Bot connected! 🎉");
            if (st.chat_id) onLinked?.(st.chat_id);
          }
        } catch {
          // transient poll failure — keep polling till the 15-min token expiry
        }
      }, 2000);
    } catch (err) {
      setConnectState("error");
      setConnectMsg(err instanceof Error ? err.message : "connect failed");
    }
  };

  if (connectState === "linked") {
    return (
      <div className="flex items-center gap-2 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
        <span>✅ Bot connected{username ? ` — ${username}` : ""}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connectState === "waiting"}
        className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {connectState === "waiting" ? "Waiting for START…" : "📲 Connect Bot"}
      </button>
      {connectMsg && (
        <p className={`mt-2 text-sm ${connectState === "error" ? "text-red-600" : "text-neutral-600"}`}>
          {connectMsg}
        </p>
      )}
      {connectState === "error" && (
        <button
          type="button"
          onClick={() => void connect()}
          className="mt-2 block rounded border border-neutral-400 px-3 py-1.5 text-sm hover:bg-neutral-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}
