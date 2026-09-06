"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Ellipsis, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CountryItineraryDetailsDialog } from "@/components/country/country-itinerary-details-dialog";
import { ItineraryTripSummarySection } from "@/components/country/itinerary-route-map";
import { BookingCenterSection } from "@/components/country/booking-center-section";
import { TravelWalletSection } from "@/components/country/travel-wallet-section";
import { TripActualSection } from "@/components/country/trip-actual-section";
import { TripChecklistSection } from "@/components/country/trip-checklist-section";
import { TripJournalSection } from "@/components/country/trip-journal-section";
import { TripPackingSection } from "@/components/country/trip-packing-section";
import { TripSummarySection } from "@/components/country/trip-summary-section";
import { PhotoGallery } from "@/components/gallery/photo-gallery";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TripAccommodationTab } from "@/components/trips/trip-accommodation-tab";
import { DeleteTripDialog } from "@/components/trips/delete-trip-dialog";
import { TripFoodTab } from "@/components/trips/trip-food-tab";
import { TripBudgetTab } from "@/components/trips/trip-budget-tab";
import { TripHeroHeader } from "@/components/trips/trip-hero-header";
import { TripItineraryTab } from "@/components/trips/trip-itinerary-tab";
import { TripOverviewTab } from "@/components/trips/trip-overview-tab";
import { TripPrimaryMetrics } from "@/components/trips/trip-primary-metrics";
import { TripTabNav, type TripTabValue } from "@/components/trips/trip-tab-nav";
import { TripTransportTab } from "@/components/trips/trip-transport-tab";
import { useItineraryDialogController } from "@/lib/hooks/use-itinerary-dialog-controller";
import { formatTripDateRangeExpanded } from "@/lib/format";
import { itineraryDisplayTitle } from "@/lib/itinerary-pdf-export";
import { appendDocument } from "@/lib/trip-documents";
import type { ReadinessCategory } from "@/lib/trip-readiness";
import { useCountryByIso } from "@/lib/queries/countries";
import { useItineraryById } from "@/lib/queries/itineraries";
import { useRenameTripHubItinerary } from "@/lib/queries/trip-hub";
import { buildTripHubTrip } from "@/lib/trip-hub";

// Readiness categories point at the modal's old section keys — map them onto
// this page's tab values so "⚠ N דברים דורשים טיפול" jumps to the right tab.
const SECTION_TO_TAB: Record<ReadinessCategory["section"], TripTabValue> = {
  route: "itinerary",
  bookings: "bookings",
  wallet: "more",
  checklist: "more",
  trip_summary: "summary",
  packing: "more",
};

function TripPageSkeleton() {
  return (
    <div className="mx-auto max-w-[1450px] space-y-4 px-4 py-4 sm:px-6">
      <Skeleton className="h-56 rounded-[28px] sm:h-64" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-12 rounded-2xl" />
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}

function TripNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-20 text-center">
      <h1 className="font-heading text-2xl font-semibold">לא הצלחנו למצוא את הטיול.</h1>
      <Button render={<Link href="/trips" />}>חזרה לטיולים שלי</Button>
    </div>
  );
}

export function TripPageClient({ tripId }: { tripId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = (searchParams?.get("tab") as TripTabValue | null) ?? "overview";
  const dayParam = searchParams?.get("day") ?? null;
  const [moreSection, setMoreSection] = useState<"checklist" | "wallet" | "packing" | "actual">("checklist");
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { data: lookupResult, isLoading, isFetched } = useItineraryById(tripId);
  const isoA2 = lookupResult?.isoA2;
  const { data: country } = useCountryByIso(isoA2);
  const controller = useItineraryDialogController(isoA2 ?? "");
  const renameItinerary = useRenameTripHubItinerary();

  const hasSeededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lookupResult || hasSeededRef.current === lookupResult.id) return;
    hasSeededRef.current = lookupResult.id;
    controller.openItinerary(lookupResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupResult]);

  const draft = controller.draft;

  const [selectedDayId, setSelectedDayId] = useState("");
  useEffect(() => {
    if (!draft) return;
    if (dayParam) {
      const match = draft.itineraryDays.find(
        (day) => day.id === dayParam || String(day.dayNumber) === dayParam
      );
      if (match) {
        setSelectedDayId(match.id);
        return;
      }
    }
    setSelectedDayId((current) =>
      current && draft.itineraryDays.some((day) => day.id === current)
        ? current
        : (draft.itineraryDays[0]?.id ?? "")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, dayParam]);

  function goToTab(tab: TripTabValue, dayId?: string) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", tab);
    if (dayId) params.set("day", dayId);
    else params.delete("day");
    router.replace(`/trips/${tripId}?${params.toString()}`, { scroll: false });
  }

  // Section "FOOD TAB FILTERING" — clicking a meal opportunity in the
  // itinerary opens the Food tab already focused on that exact day/slot,
  // never a generic unscoped Food tab.
  const [foodFocus, setFoodFocus] = useState<{ dayId: string; slot: "breakfast" | "lunch" | "dinner"; token: number } | null>(null);
  function openFoodOpportunity(dayId: string, dayPart: string) {
    const slot = dayPart === "morning" ? "breakfast" : dayPart === "dinner" ? "dinner" : "lunch";
    setFoodFocus({ dayId, slot, token: Date.now() });
    goToTab("food");
  }

  if (isLoading || !isFetched) return <TripPageSkeleton />;
  if (!lookupResult) return <TripNotFound />;
  if (!draft || !country) return <TripPageSkeleton />;

  const trip = buildTripHubTrip(draft, {
    id: country.id,
    name: country.name,
    isoA2: country.iso_a2,
    status: country.status,
  });

  async function handleRename() {
    const nextTitle = window.prompt("שם חדש לטיול", draft!.title)?.trim();
    if (!nextTitle || nextTitle === draft!.title) return;
    try {
      await renameItinerary.mutateAsync({ isoA2: isoA2!, itineraryId: draft!.id, title: nextTitle });
      controller.patchDraft((current) => ({ ...current, title: nextTitle }));
      toast.success("השם עודכן");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "עדכון השם נכשל");
    }
  }

  function handleReadinessIssueClick(section: ReadinessCategory["section"]) {
    if (section === "wallet" || section === "checklist" || section === "packing") {
      setMoreSection(section === "wallet" ? "wallet" : section === "packing" ? "packing" : "checklist");
    }
    goToTab(SECTION_TO_TAB[section]);
  }

  return (
    <div className="mx-auto max-w-[1450px] space-y-4 px-4 py-4 sm:px-6">
      <Link
        href="/trips"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowRight className="size-4" />
        חזרה לטיולים שלי
      </Link>

      <TripHeroHeader trip={trip} />
      <TripPrimaryMetrics trip={trip} />

      <div className="flex justify-start">
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditModalOpen(true)}>
            עריכת המסלול
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={controller.isRegenerating} />}>
              <Sparkles className="size-4" />
              אופטימיזציה
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => void controller.handleRegenerate(draft!.id, "optimize_route", null, null, "fewer_transfers")}
              >
                פחות מעברים
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void controller.handleRegenerate(draft!.id, "optimize_route", null, null, "less_walking")}
              >
                פחות הליכה
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" />} aria-label="פעולות נוספות">
              <Ellipsis className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void handleRename()}>שנה שם</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void controller.handleArchive(draft!.id)}>
                העבר לארכיון
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => controller.requestDelete(draft!)}>
                מחק
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start">
        <TripTabNav activeTab={activeTab} />
        <div className="min-w-0">
        {activeTab === "overview" ? (
          <TripOverviewTab
            trip={trip}
            onPatchDay={controller.patchDay}
            onPatchItem={controller.patchItem}
            onOpenDay={(dayId) => goToTab("itinerary", dayId)}
            onReadinessIssueClick={handleReadinessIssueClick}
          />
        ) : null}

        {activeTab === "itinerary" ? (
          <TripItineraryTab
            itinerary={draft}
            countryName={country.name}
            selectedDayId={selectedDayId}
            onSelectDay={(dayId) => goToTab("itinerary", dayId)}
            onPatchDay={controller.patchDay}
            onPatchItem={controller.patchItem}
            onRemoveItem={controller.removeItemFromDay}
            onMoveItemToDay={controller.moveItemToDay}
            onPatchDraft={controller.patchDraft}
            onRegenerateDay={(dayId) => void controller.handleRegenerate(draft.id, "day", dayId)}
            isRegenerating={controller.isRegenerating}
            onOpenFoodOpportunity={openFoodOpportunity}
          />
        ) : null}

        {activeTab === "map" ? (
          <ItineraryTripSummarySection
            days={draft.itineraryDays}
            countryName={country.name}
            isoA2={draft.isoA2}
            onPatchDay={controller.patchDay}
            onPatchItem={controller.patchItem}
            onOpenDay={(dayId) => goToTab("itinerary", dayId)}
          />
        ) : null}

        {activeTab === "accommodation" ? (
          <TripAccommodationTab
            days={draft.itineraryDays}
            isoA2={draft.isoA2}
            countryName={country.name}
            flights={draft.preferencesSnapshot.flights}
            onPatchDay={controller.patchDay}
          />
        ) : null}
        {activeTab === "food" ? (
          <TripFoodTab
            days={draft.itineraryDays}
            isoA2={draft.isoA2}
            onPatchDay={controller.patchDay}
            focusDayId={foodFocus?.dayId ?? null}
            focusSlot={foodFocus?.slot ?? null}
            focusToken={foodFocus?.token ?? null}
          />
        ) : null}
        {activeTab === "transport" ? <TripTransportTab days={draft.itineraryDays} /> : null}
        {activeTab === "budget" ? <TripBudgetTab itinerary={draft} /> : null}

        {activeTab === "bookings" ? (
          <BookingCenterSection draft={draft} onPatchDraft={controller.patchDraft} />
        ) : null}
        {activeTab === "journal" ? <TripJournalSection draft={draft} onPatchDraft={controller.patchDraft} /> : null}
        {activeTab === "photos" ? <PhotoGallery itineraryId={draft.id} countryId={draft.countryId} /> : null}
        {activeTab === "summary" ? (
          <TripSummarySection draft={draft} country={country} onPatchDraft={controller.patchDraft} />
        ) : null}

        {activeTab === "more" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { value: "checklist", label: "צ'קליסט" },
                  { value: "wallet", label: "ארנק נסיעות" },
                  { value: "packing", label: "אריזה" },
                  { value: "actual", label: "בפועל" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMoreSection(option.value)}
                  className={
                    moreSection === option.value
                      ? "rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                      : "rounded-xl bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            {moreSection === "checklist" ? (
              <TripChecklistSection draft={draft} onPatchDraft={controller.patchDraft} isoA2={draft.isoA2} />
            ) : null}
            {moreSection === "wallet" ? (
              <TravelWalletSection
                draft={draft}
                onPatchDraft={controller.patchDraft}
                isoA2={draft.isoA2}
                onDocumentUploaded={(document) => appendDocument(controller.patchDraft, document)}
              />
            ) : null}
            {moreSection === "packing" ? <TripPackingSection draft={draft} onPatchDraft={controller.patchDraft} /> : null}
            {moreSection === "actual" ? (
              <TripActualSection draft={draft} onPatchDay={controller.patchDay} onPatchItem={controller.patchItem} />
            ) : null}
          </div>
        ) : null}
        </div>
      </div>

      <CountryItineraryDetailsDialog
        open={editModalOpen}
        draft={controller.draft}
        activeItinerary={controller.activeItinerary}
        country={country}
        versions={controller.versions}
        isDirty={controller.isDirty}
        isSaving={controller.isSaving}
        isRegenerating={controller.isRegenerating}
        onOpenChange={(open) => {
          // Deliberately not `controller.closeModal`/`closeItinerary` — those
          // clear the controller's draft entirely, which the page itself
          // still needs to keep rendering after the edit surface closes.
          if (!open && controller.isDirty && !window.confirm("יש שינויים שלא נשמרו. לסגור בכל זאת?")) {
            return;
          }
          setEditModalOpen(open);
        }}
        onSave={controller.saveDraft}
        onReset={controller.resetDraft}
        onLoadWorkspace={() => {}}
        onPatchDraft={controller.patchDraft}
        onPatchDay={controller.patchDay}
        onPatchItem={controller.patchItem}
        onRegenerate={controller.handleRegenerate}
        onRestore={controller.handleRestore}
        onArchive={controller.handleArchive}
        onDelete={() => controller.requestDelete(draft!)}
        onExport={controller.exportItinerary}
      />

      {controller.deleteTarget ? (
        <DeleteTripDialog
          open
          onOpenChange={(open) => {
            if (!open) controller.cancelDelete();
          }}
          tripName={itineraryDisplayTitle(controller.deleteTarget, country.name)}
          tripDates={formatTripDateRangeExpanded(
            controller.deleteTarget.startDate,
            controller.deleteTarget.endDate,
            controller.deleteTarget.preferencesSnapshot.partialDate
          )}
          tripDuration={`${controller.deleteTarget.daysCount} ימים`}
          onConfirm={async () => {
            await controller.confirmDelete();
            router.push("/trips");
          }}
        />
      ) : null}
    </div>
  );
}
