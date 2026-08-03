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
import { RATING_CATEGORIES, useCountryRating, useUpsertCountryRating } from "@/lib/queries/ratings";
import type { Tables } from "@/lib/supabase/types";

type RatingKey = (typeof RATING_CATEGORIES)[number]["key"];
type RatingValues = Partial<Record<RatingKey, number>>;

function fromRow(row: Tables<"country_ratings"> | null | undefined): RatingValues {
  if (!row) return {};
  const values: RatingValues = {};
  for (const { key } of RATING_CATEGORIES) {
    const v = row[key];
    if (v != null) values[key] = v;
  }
  return values;
}

interface CountryRatingsSectionProps {
  countryId: string;
}

export function CountryRatingsSection({ countryId }: CountryRatingsSectionProps) {
  const { data: rating, isLoading } = useCountryRating(countryId);
  const upsertRating = useUpsertCountryRating();
  const [values, setValues] = useState<RatingValues>({});

  useEffect(() => {
    setValues(fromRow(rating));
  }, [rating]);

  async function handleChange(key: RatingKey, value: string) {
    const next = { ...values, [key]: Number(value) };
    setValues(next);
    try {
      await upsertRating.mutateAsync({ country_id: countryId, ...next });
    } catch {
      toast.error("שמירת הדירוג נכשלה");
    }
  }

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <section className="glass-card space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">דירוג אישי</h2>
        {rating?.overall != null && (
          <div className="flex items-center gap-1.5 text-lg font-semibold">
            <Star className="size-5 fill-current text-amber-500" />
            {rating.overall.toFixed(2)}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {RATING_CATEGORIES.map(({ key, label }) => (
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
                {[1, 2, 3, 4, 5].map((n) => (
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
