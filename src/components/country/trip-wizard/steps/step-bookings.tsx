"use client";

import { Plus, Trash2 } from "lucide-react";

import { PreferenceField } from "@/components/country/trip-preferences-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createEmptyBooking } from "@/lib/trip-bookings";
import { BOOKING_TYPE_LABELS, type BookingType, type TripBooking } from "@/lib/trip-workspace";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

/**
 * Fixed bookings become hard constraints for the AI (buildPrompt already
 * serializes payload.bookings — spec Step 7). No day/item exists yet, so
 * dayId/itineraryItemId stay null, matching how buildPrompt already reads
 * bookings independent of day linkage.
 */
export function StepBookings({
  draft,
  updateDraft,
}: {
  draft: TripCreationDraft;
  updateDraft: (patch: Partial<TripCreationDraft>) => void;
}) {
  function addBooking() {
    updateDraft({ bookings: [...draft.bookings, createEmptyBooking("wizard-draft")] });
  }

  function patchBooking(id: string, patch: Partial<TripBooking>) {
    updateDraft({
      bookings: draft.bookings.map((booking) => (booking.id === id ? { ...booking, ...patch } : booking)),
    });
  }

  function removeBooking(id: string) {
    updateDraft({ bookings: draft.bookings.filter((booking) => booking.id !== id) });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        הזמנות קיימות (מלון, טיסה, כרטיס לאטרקציה, מסעדה, אירוע...) הופכות לאילוץ קבוע שה-AI חייב לתכנן סביבו.
        אופציונלי.
      </p>

      {draft.bookings.map((booking) => (
        <div key={booking.id} className="space-y-3 rounded-xl border border-border/70 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <PreferenceField label="סוג">
                <Select
                  value={booking.type}
                  onValueChange={(value) => patchBooking(booking.id, { type: value as BookingType })}
                >
                  <SelectTrigger>
                    <span>{BOOKING_TYPE_LABELS[booking.type]}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(BOOKING_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </PreferenceField>
              <PreferenceField label="שם / כותרת">
                <Input
                  value={booking.title}
                  onChange={(event) => patchBooking(booking.id, { title: event.target.value })}
                  placeholder="לדוגמה: מלון רדיסון טביליסי"
                />
              </PreferenceField>
              <PreferenceField label="תאריך ושעה">
                <Input
                  type="datetime-local"
                  value={booking.startDateTime}
                  onChange={(event) => patchBooking(booking.id, { startDateTime: event.target.value })}
                />
              </PreferenceField>
              <PreferenceField label="מקום">
                <Input
                  value={booking.location}
                  onChange={(event) => patchBooking(booking.id, { location: event.target.value })}
                  placeholder="עיר / כתובת"
                />
              </PreferenceField>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-destructive"
              onClick={() => removeBooking(booking.id)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <PreferenceField label="הערות">
            <Textarea
              value={booking.notes}
              onChange={(event) => patchBooking(booking.id, { notes: event.target.value })}
              rows={2}
            />
          </PreferenceField>
        </div>
      ))}

      <Button type="button" variant="outline" className="gap-1.5" onClick={addBooking}>
        <Plus className="size-4" />
        הוספת הזמנה
      </Button>
    </div>
  );
}
