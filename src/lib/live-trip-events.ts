import type { CountryItineraryRecord } from "@/lib/itineraries";
import { createId, type LiveTripEvent, type LiveTripEventType } from "@/lib/trip-workspace";

type PatchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;

export function liveEvents(itinerary: CountryItineraryRecord | null): LiveTripEvent[] {
  return itinerary?.workspaceSnapshot?.liveEvents ?? [];
}

/**
 * Appends one meaningful live-trip event (spec §38: never log excessive
 * UI-only events — this is only ever called from the small set of real
 * live actions: complete/skip/delay/replace/route-change/spontaneous-add/
 * day-complete).
 */
export function appendLiveEvent(
  patchDraft: PatchDraft,
  event: { tripId: string; dayId: string | null; itemId: string | null; type: LiveTripEventType; detail: string }
) {
  patchDraft((current) => {
    const nextEvent: LiveTripEvent = {
      id: createId("live-event"),
      tripId: event.tripId,
      dayId: event.dayId,
      itemId: event.itemId,
      type: event.type,
      detail: event.detail,
      timestamp: new Date().toISOString(),
    };
    return {
      ...current,
      workspaceSnapshot: {
        ...current.workspaceSnapshot,
        liveEvents: [...liveEvents(current), nextEvent],
      },
    };
  });
}
