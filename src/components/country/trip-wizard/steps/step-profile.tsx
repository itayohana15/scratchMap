"use client";

import { ProfilePreferencesSummary } from "@/components/country/trip-preferences-panel";
import type { ProfileSummaryLine } from "@/lib/trip-preference-overrides";

/** Read-only — editing the global profile happens at /profile, not here (spec Step 3). */
export function StepProfile({
  isLoading,
  summaryLines,
}: {
  isLoading: boolean;
  summaryLines: ProfileSummaryLine[];
}) {
  return <ProfilePreferencesSummary isLoading={isLoading} summaryLines={summaryLines} />;
}
