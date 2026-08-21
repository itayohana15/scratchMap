"use client";

import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PERSONAL_RATING_OPTIONS,
  TRIP_RATING_CATEGORIES,
  useTripRating,
  useUpsertTripRating,
  type TripRatingCategoryKey,
} from "@/lib/queries/trip-ratings";
import type { Tables } from "@/lib/supabase/types";

type RatingValues = Partial<Record<TripRatingCategoryKey, number>> & { overall?: number };

function fromRow(row: Tables<"trip_ratings"> | null | undefined): RatingValues {
  if (!row) return {};
  const values: RatingValues = {};
  if (row.overall != null) values.overall = row.overall;
  for (const { key } of TRIP_RATING_CATEGORIES) {
    const v = row[key];
    if (v != null) values[key] = v;
  }
  return values;
}

interface TripRatingsSectionProps {
  itineraryId: string;
}

export function TripRatingsSection({ itineraryId }: TripRatingsSectionProps) {
  const { data: rating, isLoading } = useTripRating(itineraryId);
  const upsertRating = useUpsertTripRating();
  const [values, setValues] = useState<RatingValues>({});

  useEffect(() => {
    setValues(fromRow(rating));
  }, [rating]);

  async function handleChange(key: TripRatingCategoryKey | "overall", value: string) {
    const next = { ...values, [key]: Number(value) };
    setValues(next);
    try {
      await upsertRating.mutateAsync({ itinerary_id: itineraryId, ...next });
    } catch {
      toast.error("שמירת הדירוג נכשלה");
    }
  }

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <section className="section-card space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Star className="size-5 fill-current text-warning" />
          <h2 className="font-heading text-lg font-semibold">דירוג כללי</h2>
        </div>
        <Select
          value={values.overall?.toString() ?? ""}
          onValueChange={(v) => v && handleChange("overall", v)}
        >
          <SelectTrigger size="sm" className="w-24">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {PERSONAL_RATING_OPTIONS.map((n) => (
              <SelectItem key={n} value={n.toString()}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        הדירוג הכללי הוא הערכה אישית נפרדת מהממוצע של הקטגוריות למטה.
      </p>

      <div className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
        {TRIP_RATING_CATEGORIES.map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{label}</span>
            <Select
              value={values[key]?.toString() ?? ""}
              onValueChange={(v) => v && handleChange(key, v)}
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {PERSONAL_RATING_OPTIONS.map((n) => (
                  <SelectItem key={n} value={n.toString()}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </section>
  );
}
