"use client";

import { NotebookPen, Star } from "lucide-react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TripItineraryItem, TripMemoryPhoto } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

function StarRating({ value, onChange }: { value: number | null; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          className="transition-transform duration-150 active:scale-90"
          aria-label={`${star} כוכבים`}
        >
          <Star
            className={cn(
              "size-5",
              value != null && star <= value ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"
            )}
          />
        </button>
      ))}
    </div>
  );
}

interface PersonalLogSectionProps {
  item: TripItineraryItem;
  photos: TripMemoryPhoto[];
  onUpdate: (patch: Partial<TripItineraryItem>) => void;
}

// Shown only once an item is marked visited. Every field is user-entered —
// this is a personal log, not a sourced fact, so there's nothing to hide or
// validate against a provider.
export function PersonalLogSection({ item, photos, onUpdate }: PersonalLogSectionProps) {
  return (
    <ModalSection title="יומן טיול אישי" icon={NotebookPen}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">דירוג אישי</label>
          <StarRating value={item.personalRating} onChange={(value) => onUpdate({ personalRating: value })} />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">האם הייתם מבקרים שוב?</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ wouldVisitAgain: true })}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                item.wouldVisitAgain === true
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              )}
            >
              כן
            </button>
            <button
              type="button"
              onClick={() => onUpdate({ wouldVisitAgain: false })}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                item.wouldVisitAgain === false
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              )}
            >
              לא
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">עלות בפועל</label>
          <Input
            type="number"
            value={item.actualCost ?? ""}
            onChange={(event) =>
              onUpdate({ actualCost: event.target.value ? Number(event.target.value) : null })
            }
            placeholder="לא הוזן"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">משך ביקור בפועל (דקות)</label>
          <Input
            type="number"
            value={item.actualDurationMinutes ?? ""}
            onChange={(event) =>
              onUpdate({ actualDurationMinutes: event.target.value ? Number(event.target.value) : null })
            }
            placeholder="לא הוזן"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">הערות אישיות</label>
        <Textarea
          value={item.journalNotes}
          onChange={(event) => onUpdate({ journalNotes: event.target.value })}
          rows={3}
          placeholder="איך היה? מה כדאי לזכור לפעם הבאה?"
        />
      </div>

      {photos.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">תמונות</label>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((photo) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={photo.id}
                src={photo.imageUrl}
                alt={photo.caption}
                className="h-20 w-full rounded-lg object-cover"
              />
            ))}
          </div>
        </div>
      )}
    </ModalSection>
  );
}
