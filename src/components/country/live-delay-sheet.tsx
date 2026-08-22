"use client";

import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { computeDelayImpact, type DelayEffect } from "@/lib/live-trip-planner";
import type { TripItineraryDay } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

export type DelayAction = "shift_day" | "remove_optional" | "shorten_flexible" | "leave_as_is" | "ai_replan";

interface LiveDelaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  day: TripItineraryDay;
  fromItemId: string;
  onChooseAction: (action: DelayAction, delayMinutes: number) => void;
}

function DelayEffectRow({ effect }: { effect: DelayEffect }) {
  const Icon = effect.status === "ok" ? CheckCircle2 : effect.status === "risk" ? TriangleAlert : XCircle;
  return (
    <div
      className={cn(
        "rounded-[16px] border p-3 text-sm",
        effect.status === "conflict" ? "border-destructive/50 bg-destructive/5" : "border-border/60 bg-background/70"
      )}
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Icon className="size-4 shrink-0" />
        {effect.itemName}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{effect.detail}</p>
    </div>
  );
}

/** The "אני מאחר" flow (spec §12-13): pick a delay amount, see specific
 * per-item impact, then choose how to respond — never applies anything
 * before the user picks an action. */
export function LiveDelaySheet({ open, onOpenChange, day, fromItemId, onChooseAction }: LiveDelaySheetProps) {
  const [delayMinutes, setDelayMinutes] = useState<number | null>(null);
  const [customMinutes, setCustomMinutes] = useState("");

  const impact = delayMinutes != null ? computeDelayImpact(day, delayMinutes, fromItemId) : null;

  function reset() {
    setDelayMinutes(null);
    setCustomMinutes("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>אני מאחר</SheetTitle>
          <SheetDescription>כמה זמן?</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {delayMinutes == null ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="lg" onClick={() => setDelayMinutes(15)}>
                15 דקות
              </Button>
              <Button variant="outline" size="lg" onClick={() => setDelayMinutes(30)}>
                30 דקות
              </Button>
              <Button variant="outline" size="lg" onClick={() => setDelayMinutes(60)}>
                שעה
              </Button>
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={customMinutes}
                  onChange={(event) => setCustomMinutes(event.target.value)}
                  placeholder="זמן אחר (דק')"
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    const minutes = Number(customMinutes);
                    if (minutes > 0) setDelayMinutes(minutes);
                  }}
                >
                  אישור
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">איחור של {delayMinutes} דקות</p>
                <Button variant="ghost" size="sm" onClick={reset}>
                  שנה
                </Button>
              </div>

              {impact?.isTransferDay ? (
                <Badge variant="destructive" className="gap-1">
                  <TriangleAlert className="size-3.5" />
                  יום מעבר — רגישות גבוהה לעיכובים
                </Badge>
              ) : null}

              {impact && impact.effects.length > 0 ? (
                <div className="space-y-2">
                  {impact.effects.map((effect) => (
                    <DelayEffectRow key={effect.itemId} effect={effect} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">אין פעילויות נוספות היום שיושפעו.</p>
              )}

              <div className="space-y-2 border-t border-border/60 pt-4">
                <p className="text-sm font-medium text-foreground">מה תרצה לעשות?</p>
                <div className="grid gap-2">
                  <Button size="lg" onClick={() => onChooseAction("shift_day", delayMinutes)}>
                    הזז את המשך היום
                  </Button>
                  <Button variant="outline" onClick={() => onChooseAction("remove_optional", delayMinutes)}>
                    הסר פעילות אופציונלית
                  </Button>
                  <Button variant="outline" onClick={() => onChooseAction("shorten_flexible", delayMinutes)}>
                    קצר זמן בפעילויות גמישות
                  </Button>
                  <Button variant="outline" onClick={() => onChooseAction("leave_as_is", delayMinutes)}>
                    השאר את המסלול כפי שהוא
                  </Button>
                  <Button variant="secondary" onClick={() => onChooseAction("ai_replan", delayMinutes)}>
                    תן ל-AI לסדר את היום מחדש
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
