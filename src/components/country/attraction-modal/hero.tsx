"use client";

import { Accessibility, Bookmark, BookmarkCheck, CircleCheck, MapPin, Plus } from "lucide-react";

import { RecommendationImage } from "@/components/country/country-trip-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RECOMMENDATION_CATEGORY_LABELS, type TripRecommendation } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface AttractionHeroProps {
  recommendation: TripRecommendation;
  countryName: string;
  isSaved: boolean;
  isVisited: boolean;
  isInItinerary: boolean;
  onToggleSave: () => void;
  onAddToItinerary: () => void;
  onToggleVisited: () => void;
}

export function AttractionHero({
  recommendation,
  countryName,
  isSaved,
  isVisited,
  isInItinerary,
  onToggleSave,
  onAddToItinerary,
  onToggleVisited,
}: AttractionHeroProps) {
  const badges: { label: string }[] = [];
  if (recommendation.wheelchairAccessible === true) badges.push({ label: "נגיש לכיסא גלגלים" });
  if (recommendation.isFree === true) badges.push({ label: "כניסה חופשית" });
  if (recommendation.isFree === false) badges.push({ label: "כרוך בתשלום" });

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(240px,0.9fr)]">
      <RecommendationImage
        recommendation={recommendation}
        className="h-36 rounded-[1.75rem] border border-border/60 shadow-none sm:h-full"
      />

      <div className="flex flex-col justify-between gap-2.5">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{RECOMMENDATION_CATEGORY_LABELS[recommendation.category]}</Badge>
            {badges.map((badge) => (
              <Badge key={badge.label} variant="outline" className="gap-1">
                {badge.label === "נגיש לכיסא גלגלים" && <Accessibility className="size-3.5" />}
                {badge.label}
              </Badge>
            ))}
          </div>

          <h2 className="font-heading text-xl font-semibold leading-tight">{recommendation.name}</h2>

          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="size-4 shrink-0" />
            {recommendation.location || countryName}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant={isSaved ? "secondary" : "outline"}
            className="gap-1.5"
            onClick={onToggleSave}
          >
            {isSaved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            {isSaved ? "שמור" : "שמירה"}
          </Button>

          {!isInItinerary && (
            <Button className="gap-1.5" onClick={onAddToItinerary}>
              <Plus className="size-4" />
              הוסף למסלול
            </Button>
          )}

          <Button
            variant={isVisited ? "secondary" : "outline"}
            className={cn("gap-1.5", isVisited && "text-emerald-600 dark:text-emerald-400")}
            onClick={onToggleVisited}
          >
            <CircleCheck className="size-4" />
            {isVisited ? "בוצע ביקור" : "סמן כביקור שבוצע"}
          </Button>
        </div>
      </div>
    </div>
  );
}
