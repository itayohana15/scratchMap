import type { Metadata } from "next";

import { TravelProfileSection } from "@/components/profile/travel-profile-section";

export const metadata: Metadata = { title: "פרופיל הטיולים שלי" };
export const dynamic = "force-dynamic";

export default function ProfilePage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <TravelProfileSection />
    </main>
  );
}
