"use client";

import { BookOpen, Ticket } from "lucide-react";
import { toast } from "sonner";

import { DescriptionSection } from "@/components/country/attraction-modal/description";
import { NearbySection } from "@/components/country/attraction-modal/nearby";
import { PersonalLogSection } from "@/components/country/attraction-modal/personal-log";
import { ModalSection } from "@/components/country/attraction-modal/shared";
import { TravelInfoSection } from "@/components/country/attraction-modal/travel-info";
import { ActivityEditMode } from "@/components/trips/activity-modal/edit-mode";
import { ActivityHero } from "@/components/trips/activity-modal/hero";
import { LocationSection } from "@/components/trips/activity-modal/location-section";
import { ActivityQuickInfoGrid } from "@/components/trips/activity-modal/quick-info";
import { StatusActions } from "@/components/trips/activity-modal/status-actions";
import { TipsSection } from "@/components/trips/activity-modal/tips-section";
import { useActivityModalData } from "@/components/trips/activity-modal/use-activity-modal-data";
import { WhyInItinerarySection } from "@/components/trips/activity-modal/why-here";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { createEmptyBooking, upsertBooking } from "@/lib/trip-bookings";
import {
  type TripItineraryDay,
  type TripItineraryItem,
  type TripMemoryPhoto,
  type TripPreferences,
} from "@/lib/trip-workspace";
import { useWikipediaSummaryByName } from "@/lib/wikipedia/summary";

interface ActivityDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: TripItineraryItem | null;
  day: TripItineraryDay | null;
  days: TripItineraryDay[];
  previousItem: TripItineraryItem | null;
  countryName: string;
  itineraryId: string;
  preferences: TripPreferences;
  memories: TripMemoryPhoto[];
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
  onRemoveItem: (dayId: string, itemId: string) => void;
  onMoveItemToDay: (fromDayId: string, toDayId: string, itemId: string) => void;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  onShowOnDailyMap: (itemId: string) => void;
}

/**
 * Trip-page equivalent of the country page's AttractionModal, wired to an
 * already-placed TripItineraryItem instead of a pre-generation
 * TripRecommendation. Reuses that system's sub-components wherever their
 * props are already TripItineraryItem-typed or fully generic
 * (DescriptionSection, TravelInfoSection, PersonalLogSection, NearbySection,
 * ModalSection) — see the approved plan for the reuse map.
 */
export function ActivityDetailsModal({
  open,
  onOpenChange,
  item,
  day,
  days,
  previousItem,
  countryName,
  itineraryId,
  preferences,
  memories,
  onPatchItem,
  onRemoveItem,
  onMoveItemToDay,
  onPatchDraft,
  onShowOnDailyMap,
}: ActivityDetailsModalProps) {
  const wikipedia = useWikipediaSummaryByName(open ? item?.name : null, item?.location || countryName);
  const { nearby, drivingRoute } = useActivityModalData(item, previousItem, open);

  if (!item || !day) return null;

  function update(patch: Partial<TripItineraryItem>) {
    onPatchItem(day!.id, item!.id, (current) => ({ ...current, ...patch }));
  }

  const otherDays = days.filter((candidate) => candidate.id !== day!.id);

  function handleRemove() {
    onRemoveItem(day!.id, item!.id);
    onOpenChange(false);
  }

  function handleMoveToDay(toDayId: string) {
    onMoveItemToDay(day!.id, toDayId, item!.id);
    onOpenChange(false);
  }

  function handleShowOnMap() {
    onOpenChange(false);
    onShowOnDailyMap(item!.id);
  }

  function handleAddBooking() {
    const booking = createEmptyBooking(itineraryId);
    upsertBooking(onPatchDraft, {
      ...booking,
      title: item!.name,
      itineraryItemId: item!.id,
      dayId: day!.id,
      location: item!.location,
      startDateTime: day!.date && item!.plannedStartTime ? `${day!.date}T${item!.plannedStartTime}` : day!.date,
    });
    toast.success("נוסף לרשימת ההזמנות שלך");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-64px)] w-[min(900px,calc(100vw-64px))] flex-col gap-0 overflow-hidden rounded-[2rem] border border-border/70 bg-background p-0 sm:max-w-none">
        <DialogTitle className="sr-only">{item.name}</DialogTitle>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          <ActivityHero item={item} countryName={countryName} open={open} />

          <div className="space-y-1">
            <h2 className="font-heading text-xl font-semibold leading-tight">{item.name}</h2>
            <p className="text-sm text-muted-foreground">{item.location || countryName}</p>
          </div>

          <StatusActions
            item={item}
            otherDays={otherDays}
            onUpdate={update}
            onRemove={handleRemove}
            onMoveToDay={handleMoveToDay}
          />

          <DescriptionSection
            shortDescription={item.shortDescription}
            wikipedia={wikipedia.data}
            wikipediaLoading={wikipedia.isLoading}
          />

          <ActivityQuickInfoGrid item={item} />

          <WhyInItinerarySection item={item} day={day} previousItem={previousItem} preferences={preferences} />

          <LocationSection item={item} onShowOnDailyMap={handleShowOnMap} />

          <TravelInfoSection
            previousItem={previousItem}
            drivingRoute={drivingRoute.data}
            drivingRouteLoading={drivingRoute.isLoading}
          />

          <NearbySection
            title="אוכל קרוב"
            categories={["restaurant", "cafe", "dessert"]}
            places={nearby.data?.places}
            isLoading={nearby.isLoading}
          />

          <NearbySection
            title="מה עוד יש באזור"
            categories={["attraction", "hotel"]}
            places={nearby.data?.places}
            isLoading={nearby.isLoading}
          />

          <TipsSection item={item} />

          {item.reservationRequired ? (
            <ModalSection title="נדרשת הזמנה מראש" icon={Ticket}>
              {item.bookingWarning ? <p className="text-sm text-muted-foreground">{item.bookingWarning}</p> : null}
              <button
                type="button"
                onClick={handleAddBooking}
                className="text-sm font-medium text-primary hover:underline"
              >
                הוסף להזמנות שלי
              </button>
            </ModalSection>
          ) : null}

          <ModalSection title="הערות שלי" icon={BookOpen}>
            <Textarea
              value={item.plannedNotes}
              onChange={(event) => update({ plannedNotes: event.target.value })}
              rows={2}
              placeholder="לדוגמה: להגיע לפני השקיעה, לקנות כרטיס מראש..."
            />
          </ModalSection>

          {item.completed ? (
            <PersonalLogSection
              item={item}
              photos={memories.filter((memory) => memory.relatedItemId === item.id)}
              onUpdate={update}
            />
          ) : null}

          <ActivityEditMode item={item} day={day} otherDays={otherDays} onUpdate={update} onMoveToDay={handleMoveToDay} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
