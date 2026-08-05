"use client";

import { ArrowLeft, ArrowRight, Copy, ListChecks, Plus, Trash2 } from "lucide-react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import type { ItineraryPlacement } from "@/lib/trip-workspace";

interface ItineraryIntegrationSectionProps {
  placement: ItineraryPlacement | null;
  onAddToItinerary: () => void;
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

export function ItineraryIntegrationSection({
  placement,
  onAddToItinerary,
  onMoveEarlier,
  onMoveLater,
  onDuplicate,
  onRemove,
}: ItineraryIntegrationSectionProps) {
  if (!placement) {
    return (
      <ModalSection title="שילוב במסלול" icon={ListChecks}>
        <p className="text-sm text-muted-foreground">האטרקציה הזו עדיין לא נמצאת במסלול הטיול.</p>
        <Button className="w-fit gap-1.5" onClick={onAddToItinerary}>
          <Plus className="size-4" />
          הוסף למסלול
        </Button>
      </ModalSection>
    );
  }

  const { day, item, itemIndex } = placement;

  return (
    <ModalSection title="שילוב במסלול" icon={ListChecks}>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">יום</p>
          <p className="mt-1 font-medium">
            {day.title}
            {day.date ? ` · ${formatDate(day.date)}` : ""}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">מיקום בסדר היום</p>
          <p className="mt-1 font-medium">#{itemIndex + 1}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">זמן משובץ</p>
          <p className="mt-1 font-medium">{item.plannedStartTime || "לא הוגדר"}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onMoveEarlier} disabled={itemIndex === 0}>
          <ArrowRight className="size-4" />
          הזז מוקדם יותר
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onMoveLater}
          disabled={itemIndex === day.items.length - 1}
        >
          <ArrowLeft className="size-4" />
          הזז מאוחר יותר
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onDuplicate}>
          <Copy className="size-4" />
          שכפול
        </Button>
        <Button variant="destructive" size="sm" className="gap-1.5" onClick={onRemove}>
          <Trash2 className="size-4" />
          הסרה מהמסלול
        </Button>
      </div>
    </ModalSection>
  );
}
