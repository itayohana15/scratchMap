"use client";

import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  computeTripReadiness,
  isReadinessApplicable,
  type ReadinessCategory,
} from "@/lib/trip-readiness";

/**
 * The one readiness indicator for a trip — a percent badge plus a single
 * "⚠ N דברים דורשים טיפול" dropdown (never a pill row, spec §21). Shared by
 * the trip page and the legacy modal so this logic has one home (spec §39).
 */
export function TripReadinessIndicator({
  itinerary,
  onIssueClick,
}: {
  itinerary: CountryItineraryRecord;
  onIssueClick?: (section: ReadinessCategory["section"]) => void;
}) {
  const readiness = isReadinessApplicable(itinerary.status) ? computeTripReadiness(itinerary) : null;
  if (!readiness) return null;

  const issues = readiness.categories.filter(
    (category) => category.status === "missing" || category.status === "partial"
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={readiness.overallPercent >= 80 ? "secondary" : "outline"}>
        טיול מוכן ב-{readiness.overallPercent}%
      </Badge>

      {issues.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15"
              />
            }
          >
            <TriangleAlert className="size-3.5" />
            {issues.length} דברים דורשים טיפול
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {issues.map((category) => (
              <DropdownMenuItem
                key={category.key}
                onClick={() => onIssueClick?.(category.section)}
                title={category.detail || undefined}
              >
                <TriangleAlert className="size-3.5" />
                {category.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
