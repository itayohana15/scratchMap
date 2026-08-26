"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { cn } from "@/lib/utils";

export type TripTabValue =
  | "overview"
  | "itinerary"
  | "map"
  | "accommodation"
  | "transport"
  | "budget"
  | "bookings"
  | "journal"
  | "photos"
  | "summary"
  | "more";

export const TRIP_TAB_LABELS: Record<TripTabValue, string> = {
  overview: "סקירה",
  itinerary: "מסלול",
  map: "מפה",
  accommodation: "לינה",
  transport: "תחבורה",
  budget: "תקציב",
  bookings: "הזמנות",
  journal: "יומן",
  photos: "תמונות",
  summary: "סיכום הטיול",
  more: "עוד",
};

const PRIMARY_TABS: TripTabValue[] = [
  "overview",
  "itinerary",
  "map",
  "accommodation",
  "transport",
  "budget",
  "bookings",
  "journal",
  "photos",
  "summary",
  "more",
];

/**
 * Sticky, URL-backed trip navigation (`?tab=`, spec §30) — refresh/back/
 * forward all keep the selected section, unlike the plain useState the
 * country page's own tabs use today (no URL-search-param pattern existed
 * anywhere in this app before this component).
 */
export function TripTabNav({ activeTab }: { activeTab: TripTabValue }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setTab = useCallback(
    (tab: TripTabValue) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("tab", tab);
      params.delete("day");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  return (
    <nav
      className="sticky top-0 z-30 -mx-4 flex gap-1 overflow-x-auto border-b border-border/70 bg-background/95 px-4 py-1.5 backdrop-blur-sm sm:mx-0 sm:rounded-2xl sm:border sm:px-2"
      aria-label="ניווט טיול"
    >
      {PRIMARY_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => setTab(tab)}
          className={cn(
            "shrink-0 rounded-xl px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors",
            activeTab === tab
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          {TRIP_TAB_LABELS[tab]}
        </button>
      ))}
    </nav>
  );
}
