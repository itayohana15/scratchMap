"use client";

import { ArrowRightLeft, CircleCheck, CircleDashed, Ellipsis, SkipForward, Star, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TripItineraryDay, TripItineraryItem } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

type ActivityStatus = "planned" | "completed" | "skipped" | "replaced";

function statusOf(item: TripItineraryItem): ActivityStatus {
  if (item.replaced) return "replaced";
  if (item.skipped) return "skipped";
  if (item.completed) return "completed";
  return "planned";
}

const STATUS_LABELS: Record<ActivityStatus, string> = {
  planned: "מתוכנן",
  completed: "בוצע",
  skipped: "דילגנו",
  replaced: "הוחלף",
};

const STATUS_ICONS: Record<ActivityStatus, typeof CircleDashed> = {
  planned: CircleDashed,
  completed: CircleCheck,
  skipped: SkipForward,
  replaced: ArrowRightLeft,
};

interface StatusActionsProps {
  item: TripItineraryItem;
  otherDays: TripItineraryDay[];
  onUpdate: (patch: Partial<TripItineraryItem>) => void;
  onRemove: () => void;
  onMoveToDay: (toDayId: string) => void;
}

/**
 * Status (מתוכנן/בוצע/דילגנו/הוחלף), favorite toggle, and the
 * remove/move-to-another-day overflow menu (spec items 21/23/25 — minus the
 * AI-suggested "החלף פעילות", deferred as a separate follow-up since it
 * needs a new AI-backed endpoint, not just a UI wire-up).
 */
export function StatusActions({ item, otherDays, onUpdate, onRemove, onMoveToDay }: StatusActionsProps) {
  const currentStatus = statusOf(item);

  function setStatus(status: ActivityStatus) {
    onUpdate({
      completed: status === "completed",
      skipped: status === "skipped",
      replaced: status === "replaced",
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(STATUS_LABELS) as ActivityStatus[]).map((status) => {
          const Icon = STATUS_ICONS[status];
          return (
            <Button
              key={status}
              size="sm"
              variant={currentStatus === status ? "secondary" : "outline"}
              className="gap-1.5"
              onClick={() => setStatus(status)}
            >
              <Icon className="size-3.5" />
              {STATUS_LABELS[status]}
            </Button>
          );
        })}
      </div>

      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={item.favorite ? "הסר ממועדפים" : "שמור למועדפים"}
          onClick={() => onUpdate({ favorite: !item.favorite })}
        >
          <Star className={cn("size-4", item.favorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="פעולות נוספות" />}>
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {otherDays.length > 0 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowRightLeft className="size-4" />
                  העבר ליום אחר
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {otherDays.map((otherDay) => (
                    <DropdownMenuItem key={otherDay.id} onClick={() => onMoveToDay(otherDay.id)}>
                      יום {otherDay.dayNumber}
                      {otherDay.title ? ` — ${otherDay.title}` : ""}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 className="size-4" />
              הסר מהמסלול
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
