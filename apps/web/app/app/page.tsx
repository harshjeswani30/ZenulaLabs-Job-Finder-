import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/worker";
import AppShell from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function AppPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <AppShell email={user.email} />;
}
