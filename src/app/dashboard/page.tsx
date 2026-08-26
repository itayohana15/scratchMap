import type { Metadata } from "next";

import { DashboardPageClient } from "@/components/dashboard/dashboard-page-client";

export const metadata: Metadata = { title: "דף הבית" };
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <DashboardPageClient />
    </main>
  );
}
