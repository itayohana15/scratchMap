"use client";

import { Loader2, NotebookPen, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { TripHero } from "@/components/country/trip-hero";
import { TripRatingsSection } from "@/components/country/trip-ratings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/format";
import { createWorkspaceFromItineraryRecord, type CountryItineraryRecord } from "@/lib/itineraries";
import { photoPublicUrl, usePhotosForItinerary } from "@/lib/queries/photos";
import { useGenerateTripStory } from "@/lib/queries/trip-story";
import { useTripRating } from "@/lib/queries/trip-ratings";
import { patchSummary, tripSummary } from "@/lib/trip-journal";
import {
  computeCategoryBreakdown,
  computeTripHighlights,
  computeTripMemoryStats,
  computeTripRouteStory,
} from "@/lib/trip-memories";
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

  const { data: photos = [] } = usePhotosForItinerary(draft.id);
  const { data: ratingRow } = useTripRating(draft.id);
  const generateStory = useGenerateTripStory(draft.isoA2);

  const memoryStats = computeTripMemoryStats(draft, { photosCount: photos.length, journalEntriesCount: (draft.workspaceSnapshot?.journalEntries ?? []).length });
  const categoryBreakdown = computeCategoryBreakdown(draft);
  const routeStory = computeTripRouteStory(draft);
  const highlights = computeTripHighlights(draft, photos);
  const coverPhoto = photos.find((photo) => photo.favorite) ?? null;

  async function handleGenerateStory() {
    try {
      const story = await generateStory.mutateAsync({ itineraryId: draft.id });
      onPatchDraft((current) => ({
        ...current,
        workspaceSnapshot: {
          ...current.workspaceSnapshot,
          tripStory: story,
          tripStoryGeneratedAt: new Date().toISOString(),
        },
      }));
    } catch {
      toast.error("יצירת סיפור הטיול נכשלה");
    }
  }

  const isCompleted = draft.status === "completed" || draft.status === "archived";

  return (
    <section className="space-y-6">
      {isCompleted ? (
        <TripHero
          isoA2={draft.isoA2}
          countryName={country.name}
          tripTitle={draft.title}
          startDate={draft.startDate}
          endDate={draft.endDate}
          partialDate={draft.preferencesSnapshot.partialDate}
          durationDays={memoryStats.durationDays}
          citiesCount={memoryStats.cities.length}
          placesCount={memoryStats.placesVisited}
          overallRating={ratingRow?.overall ?? null}
          favoritePhotoUrl={coverPhoto ? photoPublicUrl(coverPhoto.storage_path) : undefined}
        />
      ) : (
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground">סיכום הטיול</h3>
          <p className="text-sm text-muted-foreground">
            דירוגים, הוצאות בפועל וזיכרונות — הכל שייך רק לטיול הזה.
          </p>
        </div>
      )}

      <TripRatingsSection itineraryId={draft.id} />

      {categoryBreakdown.length > 0 ? (
        <div className="section-card space-y-3 p-4">
          <h4 className="font-medium text-foreground">התפלגות חוויות בפועל</h4>
          <div className="space-y-2">
            {categoryBreakdown.map(({ category, label, count }) => (
              <div key={category} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(count / categoryBreakdown[0].count) * 100}%` }}
                  />
                </div>
                <span className="w-6 shrink-0 text-right text-sm font-medium text-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {routeStory.length > 0 ? (
        <div className="section-card space-y-2 p-4">
          <h4 className="font-medium text-foreground">מסלול הטיול בפועל</h4>
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground/85">
            {routeStory.map((stop, index) => (
              <span key={`${stop}-${index}`} className="flex items-center gap-2">
                {index > 0 ? <span className="text-muted-foreground">←</span> : null}
                <Badge variant="outline">{stop}</Badge>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {highlights.favoriteActivities.length > 0 || highlights.favoriteMeals.length > 0 ? (
        <div className="section-card space-y-3 p-4">
          <h4 className="font-medium text-foreground">רגעים בולטים</h4>
          {highlights.favoriteActivities.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {highlights.favoriteActivities.map((item) => (
                <Badge key={item.id} variant="secondary">
                  ❤️ {item.name}
                </Badge>
              ))}
            </div>
          ) : null}
          {highlights.favoriteMeals.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {highlights.favoriteMeals.map((item) => (
                <Badge key={item.id} variant="secondary">
                  🍽️ {item.name}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="section-card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h4 className="font-medium text-foreground">סיפור הטיול</h4>
          </div>
          <Button size="sm" variant="outline" onClick={handleGenerateStory} disabled={generateStory.isPending} className="gap-1.5">
            {generateStory.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            צור סיפור מהטיול
          </Button>
        </div>
        {draft.workspaceSnapshot?.tripStory ? (
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{draft.workspaceSnapshot.tripStory}</p>
        ) : (
          <p className="text-sm text-muted-foreground">עדיין לא נוצר סיפור לטיול הזה.</p>
        )}
      </div>

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
          <p className="mt-1 text-lg font-semibold">
            {memoryStats.actualSpend.hasData ? formatCurrency(comparison.actualCost) : "לא הוזן"}
          </p>
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
          <p className="text-xs text-muted-foreground">דולגו / ספונטני</p>
          <p className="mt-1 text-lg font-semibold">
            {comparison.skippedActivities} / {comparison.spontaneousAdditions}
          </p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">ימי טיול</p>
          <p className="mt-1 text-lg font-semibold">{statistics.totalTripDays}</p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">מרחק שנוסע בפועל</p>
          <p className="mt-1 text-lg font-semibold">
            {memoryStats.distanceKm.hasData ? `${memoryStats.distanceKm.value.toLocaleString("he-IL")} ק״מ` : "לא תועד"}
          </p>
        </div>
        <div className="section-card p-4">
          <p className="text-xs text-muted-foreground">קטגוריה מובילה</p>
          <p className="mt-1 text-lg font-semibold">{statistics.topCategoryVisited || "—"}</p>
        </div>
      </div>
    </section>
  );
}
