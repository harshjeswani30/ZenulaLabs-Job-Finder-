import { getSessionUser } from "@/lib/worker";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Signed-in users go straight to the app; visitors see the landing below.
  if (await getSessionUser()) redirect("/app");

  return (
    <main className="min-h-screen">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
        <span className="text-lg font-bold">🔍 Job Finder</span>
        <div className="flex items-center gap-3 text-sm">
          <a href="/login" className="text-neutral-600 hover:text-neutral-900">Log in</a>
          <a href="/signup" className="rounded bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700">
            Get started free
          </a>
        </div>
      </nav>

      <section className="mx-auto max-w-5xl px-4 py-16 text-center sm:py-24">
        <h1 className="mx-auto mb-4 max-w-2xl text-4xl font-bold leading-tight sm:text-5xl">
          Your personal job scout, on Telegram
        </h1>
        <p className="mx-auto mb-8 max-w-xl text-lg text-neutral-600">
          Upload your resume once. Job Finder scans 1200+ company boards and free
          job sites, scores every posting against your profile, and DMs you only
          the matches — every few hours, automatically.
        </p>
        <a
          href="/signup"
          className="inline-block rounded-lg bg-neutral-900 px-8 py-3 text-base font-medium text-white hover:bg-neutral-700"
        >
          Start free — no card needed
        </a>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-20">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            {
              title: "Resume-aware matching",
              body: "Your fields and skills are extracted from your resume and every job is scored 0–100 against them.",
            },
            {
              title: "1200+ sources scanned",
              body: "Greenhouse, Lever, SmartRecruiters boards plus Remotive, RemoteOK, We Work Remotely and more.",
            },
            {
              title: "Straight to Telegram",
              body: "No dashboards to babysit — matched jobs arrive as DMs with title, company, score and apply link.",
            },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-neutral-200 bg-white p-6 text-left">
              <h3 className="mb-2 font-semibold">{f.title}</h3>
              <p className="text-sm leading-relaxed text-neutral-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-neutral-200 py-8 text-center text-sm text-neutral-500">
        Job Finder — free job matching via Telegram
      </footer>
    </main>
  );
}
