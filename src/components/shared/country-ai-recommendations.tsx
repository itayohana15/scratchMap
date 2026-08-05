"use client";

import { Bot, Sparkles, TriangleAlert, UtensilsCrossed } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useCountryAiRecommendation } from "@/lib/ai/country-recommendations";

interface CountryAiRecommendationsProps {
  isoA2: string;
  countryName: string;
  compact?: boolean;
}

export function CountryAiRecommendations({
  isoA2,
  countryName,
  compact = false,
}: CountryAiRecommendationsProps) {
  const { data, isLoading, isError, error } = useCountryAiRecommendation(isoA2, countryName);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        {!compact && <Skeleton className="h-24 w-full rounded-xl" />}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="glass-card flex items-start gap-2 px-4 py-3 text-sm text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>
          לא הצלחנו לטעון המלצות AI כרגע.{" "}
          {error instanceof Error ? error.message : "נסו שוב מאוחר יותר."}
        </span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{data.summary}</p>

      <section>
        <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-3.5 text-primary" />
          חובה לראות
        </h4>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {(compact ? data.highlights.slice(0, 3) : data.highlights).map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      </section>

      {!compact && (
        <>
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              <UtensilsCrossed className="size-3.5 text-primary" />
              אוכל שכדאי לנסות
            </h4>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {data.food.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h4 className="mb-1.5 text-sm font-medium">מתי הכי כדאי לבקר</h4>
            <p className="text-sm text-muted-foreground">{data.bestTimeToVisit}</p>
          </section>

          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              <Bot className="size-3.5 text-primary" />
              טיפים מעשיים
            </h4>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {data.tips.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
