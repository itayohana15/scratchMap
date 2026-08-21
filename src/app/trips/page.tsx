import type { Metadata } from "next";

import { TripsPageClient } from "@/components/trips/trips-page-client";

export const metadata: Metadata = { title: "הטיולים שלי" };
export const dynamic = "force-dynamic";

export default function TripsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <TripsPageClient />
    </main>
  );
}
