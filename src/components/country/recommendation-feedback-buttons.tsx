"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildPlaceKey, useFeedbackForPlace, useSubmitFeedback } from "@/lib/queries/recommendation-feedback";
import type { RecommendationCategory } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

const NEGATIVE_REASONS = ["רחוק מדי", "יקר מדי", "לא מעניין אותי", "עמוס מדי", "תיירותי מדי", "לא מתאים לאוכל שלי", "כבר הייתי", "אחר"];
const POSITIVE_REASONS = ["נשמע מעניין", "מתאים בדיוק למה שאני אוהב", "קרוב למסלול", "מחיר טוב", "מקומי ואותנטי", "מיוחד", "אחר"];

interface RecommendationFeedbackButtonsProps {
  place: { name: string; location: string; lat?: number | null; lon?: number | null };
  category: RecommendationCategory;
  tripId: string | null;
}

export function RecommendationFeedbackButtons({ place, category, tripId }: RecommendationFeedbackButtonsProps) {
  const placeKey = buildPlaceKey(place);
  const { data: feedback = [] } = useFeedbackForPlace(placeKey);
  const submitFeedback = useSubmitFeedback();
  const [reasonPicker, setReasonPicker] = useState<"up" | "down" | null>(null);

  const myLatest = feedback[0]?.feedback ?? null;

  function submit(value: "up" | "down", reason?: string) {
    submitFeedback.mutate({ placeKey, tripId, category, feedback: value, reason: reason ?? null });
    setReasonPicker(null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant={myLatest === "up" ? "secondary" : "outline"}
          aria-label="אהבתי את ההמלצה הזו"
          onClick={() => setReasonPicker(reasonPicker === "up" ? null : "up")}
        >
          <ThumbsUp className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant={myLatest === "down" ? "destructive" : "outline"}
          aria-label="לא אהבתי את ההמלצה הזו"
          onClick={() => setReasonPicker(reasonPicker === "down" ? null : "down")}
        >
          <ThumbsDown className="size-3.5" />
        </Button>
      </div>
      {reasonPicker ? (
        <div className="flex flex-wrap gap-1.5">
          {(reasonPicker === "down" ? NEGATIVE_REASONS : POSITIVE_REASONS).map((reason) => (
            <Badge
              key={reason}
              variant="outline"
              className={cn("cursor-pointer text-[11px]", reasonPicker === "down" && "hover:border-destructive/60")}
              onClick={() => submit(reasonPicker, reason)}
            >
              {reason}
            </Badge>
          ))}
          <Badge variant="secondary" className="cursor-pointer text-[11px]" onClick={() => submit(reasonPicker)}>
            שלח בלי סיבה
          </Badge>
        </div>
      ) : null}
    </div>
  );
}
