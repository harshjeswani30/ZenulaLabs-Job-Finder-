import type { ScoredJob } from "@jobfinder/shared";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatJobMessage(header: string, jobs: ScoredJob[]): string {
  const lines = jobs.map((s, i) => {
    const { title, company, location, salary, url } = s.job;
    const parts = [`<b>${i + 1}. ${esc(title)}</b> @ ${esc(company)}`];
    const meta = [`🎯 Match: ${s.score}/100`];
    if (location) meta.push(`📍 ${esc(location)}`);
    if (salary) meta.push(`💰 ${esc(salary)}`);
    parts.push(`<i>${meta.join(" · ")}</i>`);
    parts.push(`🔗 ${esc(url)}`);
    return parts.join("\n");
  });
  return `${esc(header)}\n\n${lines.join("\n\n")}`;
}

export function chunkForSending(jobs: ScoredJob[], perMessage = 8): { header: string; jobs: ScoredJob[] }[] {
  const top = jobs.slice(0, 30);
  const chunks: { header: string; jobs: ScoredJob[] }[] = [];
  for (let i = 0; i < top.length; i += perMessage) chunks.push({ header: "", jobs: top.slice(i, i + perMessage) });
  return chunks.slice(0, 4);
}

export async function sendTelegramMessage(token: string, chatId: string, text: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || body.ok === false) throw new Error(`Telegram error: ${body.description ?? res.status}`);
}
