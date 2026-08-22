import type { Metadata } from "next";

import { PassportPageClient } from "@/components/passport/passport-page-client";

export const metadata: Metadata = { title: "דרכון הטיולים שלי" };
export const dynamic = "force-dynamic";

export default function PassportPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PassportPageClient />
    </main>
  );
}
