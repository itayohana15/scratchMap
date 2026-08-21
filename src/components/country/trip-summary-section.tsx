"use client";

import { NotebookPen } from "lucide-react";

import { TripRatingsSection } from "@/components/country/trip-ratings-section";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/format";
import { createWorkspaceFromItineraryRecord, type CountryItineraryRecord } from "@/lib/itineraries";
import { patchSummary, tripSummary } from "@/lib/trip-journal";
import { buildTripComparison, buildTripStatistics } from "@/lib/trip-workspace";

interface TripSummarySectionProps {
  draft: CountryItineraryRecord;
  country: { name: string };
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
}

const SUMMARY_FIELDS: Array<{ key: keyof ReturnType<typeof tripSummary>; label: string; multiline?: boolean }> = [
  { key: "overallTripSummary", label: "סיכום כללי של הטיול", multiline: true },
  { key: "favoritePlace", label: "המקום האהוב" },
  { key: "favoriteRestaurant", label: "המסעדה האהובה" },
  { key: "favoriteMemory", label: "הזיכרון האהוב", multiline: true },
  { key: "bestDay", label: "היום הכי טוב" },
  { key: "biggestSurprise", label: "ההפתעה הגדולה", multiline: true },
  { key: "tripHighlights", label: "רגעים בולטים", multiline: true },
  { key: "differentlyNextTime", label: "מה הייתי עושה אחרת", multiline: true },
  { key: "lessonsLearned", label: "לקחים", multiline: true },
  { key: "recommendationsForOthers", label: "המלצות למטיילים אחרים", multiline: true },
];

export function TripSummarySection({ draft, country, onPatchDraft }: TripSummarySectionProps) {
  const summary = tripSummary(draft);
  const workspace = createWorkspaceFromItineraryRecord(draft, country.name);
  const statistics = buildTripStatistics(workspace);
  const comparison = buildTripComparison(workspace);

  return (
    <section className="space-y-6">
      <div>
        <h3 className="font-heading text-lg font-semibold text-foreground">סיכום הטיול</h3>
        <p className="text-sm text-muted-foreground">
          דירוגים, הוצאות בפועל וזיכרונות — הכל שייך רק לטיול הזה.
        </p>
      </div>

      <TripRatingsSection itineraryId={draft.id} />

      <div className="section-card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <NotebookPen className="size-4 text-primary" />
          <h4 className="font-medium">תובנות מהטיול</h4>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {SUMMARY_FIELDS.map(({ key, label, multiline }) => (
            <div key={key} className={multiline ? "space-y-1.5 md:col-span-2" : "space-y-1.5"}>
              <label className="text-xs font-medium text-muted-foreground">{label}</label>
              {multiline ? (
                <Textarea
                  value={summary[key] as string}
                  onChange={(event) => patchSummary(onPatchDraft, { [key]: event.target.value })}
                  rows={3}
                />
              ) : (
                <Input
                  value={summary[key] as string}
                  onChange={(event) => patchSummary(onPatchDraft, { [key]: event.target.value })}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">תקציב מתוכנן</p>
          <p className="mt-1 text-lg font-semibold">{formatCurrency(comparison.plannedCost)}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">הוצאה בפועל</p>
          <p className="mt-1 text-lg font-semibold">{formatCurrency(comparison.actualCost)}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">הפרש</p>
          <p className="mt-1 text-lg font-semibold">{formatCurrency(comparison.costDifference)}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">פעילויות שבוצעו</p>
          <p className="mt-1 text-lg font-semibold">
            {comparison.completedActivities}/{comparison.plannedActivities}
          </p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">ימי טיול</p>
          <p className="mt-1 text-lg font-semibold">{statistics.totalTripDays}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">מקומות שבוצעו</p>
          <p className="mt-1 text-lg font-semibold">{statistics.placesVisited}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">מסעדות שבוצעו</p>
          <p className="mt-1 text-lg font-semibold">{statistics.restaurantsVisited}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">קטגוריה מובילה</p>
          <p className="mt-1 text-lg font-semibold">{statistics.topCategoryVisited || "—"}</p>
        </div>
      </div>
    </section>
  );
}
