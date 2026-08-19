import type { Metadata } from "next";

import { SettingsPageClient } from "@/components/settings/settings-page-client";

export const metadata: Metadata = { title: "הגדרות" };

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <SettingsPageClient />
    </main>
  );
}
