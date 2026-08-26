import { format, isValid, parseISO } from "date-fns";
import { he } from "date-fns/locale";

import { formatTripDateRange } from "@/lib/format";
import { flightCostExpenses } from "@/lib/flight-planning";
import { getDestinationDateString } from "@/lib/live-trip-time";
import { summarizeItemCosts } from "@/lib/server/itinerary-generation-constraints";
import type { Tables } from "@/lib/supabase/types";
import { applyBookingOverrides } from "@/lib/trip-bookings";
import {
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  getTripDayCount,
  normalizeWorkspace,
  type CountryTripWorkspaceState,
  type FlightBookingStatus,
  type ItineraryGenerationMode,
  type TripExpense,
  type TripFlightLeg,
  type TripFlights,
  type TripItineraryDay,
  type TripPreferences,
} from "@/lib/trip-workspace";

export type CountryItineraryStatus = "draft" | "upcoming" | "active" | "completed" | "archived";
export type CountryItinerarySource = "ai" | "manual" | "historical_manual";
export type CountryItineraryVersionSource = "ai" | "manual" | "duplicate" | "restore" | "regenerate";

export interface ItineraryCostSummary {
  totalEstimatedCost: number | null;
  estimatedTransportCost: number | null;
  averageDailyCost: number | null;
  costPerTraveler: number | null;
  categoryBreakdown: Record<string, number>;
}

export interface CountryItineraryRecord {
  id: string;
  countryId: string;
  isoA2: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  daysCount: number;
  travelers: number;
  budget: number | null;
  generationMode: ItineraryGenerationMode;
  source: CountryItinerarySource;
  model: string | null;
  summary: string;
  preferencesSnapshot: TripPreferences;
  workspaceSnapshot: Partial<CountryTripWorkspaceState> | null;
  itineraryDays: TripItineraryDay[];
  costSummary: ItineraryCostSummary;
  status: CountryItineraryStatus;
  version: number;
  parentItineraryId: string | null;
  manuallyEdited: boolean;
  archived: boolean;
  generatedAt: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CountryItineraryVersionRecord {
  id: string;
  itineraryId: string;
  version: number;
  changeReason: string | null;
  source: CountryItineraryVersionSource;
  model: string | null;
  snapshot: CountryItineraryRecord | null;
  restoredFromVersionId: string | null;
  createdAt: string;
}

export interface CountryItineraryGenerationSuccessPayload {
  itineraryId: string;
  countryCode: string;
  countryName: string;
  startDate: string | null;
  endDate: string | null;
  totalDays: number;
  estimatedTotalCost: number | null;
  status: CountryItineraryStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(toText).filter(Boolean) : [];
}

function normalizeFlightLeg(value: unknown): TripFlightLeg | null {
  if (!isRecord(value)) return null;
  const bookingStatus =
    value.bookingStatus === "not_booked" || value.bookingStatus === "booked" || value.bookingStatus === "paid"
      ? (value.bookingStatus as FlightBookingStatus)
      : "not_booked";
  const leg: TripFlightLeg = {
    departureAirport: toText(value.departureAirport),
    arrivalAirport: toText(value.arrivalAirport),
    departureDate: toText(value.departureDate),
    departureTime: toText(value.departureTime),
    arrivalDate: toText(value.arrivalDate),
    arrivalTime: toText(value.arrivalTime),
    airline: toText(value.airline),
    flightNumber: toText(value.flightNumber),
    cost: toNumber(value.cost),
    bookingStatus,
  };
  const hasAnyData = Object.values(leg).some((field) => typeof field === "string" && field.trim() !== "");
  return hasAnyData ? leg : null;
}

function normalizeFlights(value: unknown): TripFlights | undefined {
  if (!isRecord(value)) return undefined;
  const outbound = normalizeFlightLeg(value.outbound);
  const returnLeg = normalizeFlightLeg(value.return);
  if (!outbound && !returnLeg) return undefined;
  return { outbound, return: returnLeg };
}

function normalizeTripPreferences(value: unknown): TripPreferences {
  const base = createDefaultWorkspace("Trip").preferences;
  const record = isRecord(value) ? value : {};

  const generationMode = toText(record.generationMode) as ItineraryGenerationMode;

  return {
    ...base,
    startDate: toText(record.startDate) || base.startDate,
    endDate: toText(record.endDate) || base.endDate,
    partialDate: toText(record.partialDate),
    travelers: toNumber(record.travelers) ?? base.travelers,
    budget: toNumber(record.budget),
    tripStyle: toText(record.tripStyle) || base.tripStyle,
    tripPace:
      record.tripPace === "relaxed" || record.tripPace === "balanced" || record.tripPace === "fast"
        ? record.tripPace
        : base.tripPace,
    generationMode:
      generationMode === "balanced" ||
      generationMode === "cheapest" ||
      generationMode === "fastest" ||
      generationMode === "relaxed" ||
      generationMode === "intensive" ||
      generationMode === "family_friendly" ||
      generationMode === "walking_friendly" ||
      generationMode === "safer_route"
        ? generationMode
        : base.generationMode,
    interests: toText(record.interests),
    transportationPreferences: toText(record.transportationPreferences),
    accommodationArea: toText(record.accommodationArea),
    dietaryPreferences: toText(record.dietaryPreferences),
    accessibilityNeeds: toText(record.accessibilityNeeds),
    preferredRegions: toText(record.preferredRegions),
    mustVisitPlaces: toText(record.mustVisitPlaces),
    placesToAvoid: toText(record.placesToAvoid),
    safetyConstraints: toText(record.safetyConstraints),
    flights: normalizeFlights(record.flights),
  };
}

function normalizeItineraryDays(value: unknown): TripItineraryDay[] {
  if (!Array.isArray(value)) return [];

  return value.map((dayValue, index) => {
    const dayRecord = isRecord(dayValue) ? dayValue : {};
    const baseDay = createEmptyDay(index + 1, toText(dayRecord.date));
    const items = Array.isArray(dayRecord.items)
      ? dayRecord.items.map((itemValue) => {
          const itemRecord = isRecord(itemValue) ? itemValue : {};
          const baseItem = createEmptyItineraryItem(
            itemRecord.slot === "lunch" ||
              itemRecord.slot === "afternoon" ||
              itemRecord.slot === "dinner" ||
              itemRecord.slot === "evening" ||
              itemRecord.slot === "night"
              ? itemRecord.slot
              : "morning"
          );
          return {
            ...baseItem,
            ...itemRecord,
            id: toText(itemRecord.id) || baseItem.id,
            name: toText(itemRecord.name),
            location: toText(itemRecord.location),
            shortDescription: toText(itemRecord.shortDescription),
            plannedStartTime: toText(itemRecord.plannedStartTime),
            liveScheduledStartTime: toText(itemRecord.liveScheduledStartTime) || null,
            actualStartTime: toText(itemRecord.actualStartTime),
            actualEndTime: toText(itemRecord.actualEndTime),
            estimatedDurationMinutes: toNumber(itemRecord.estimatedDurationMinutes),
            approximatePrice: toNumber(itemRecord.approximatePrice),
            priceOriginalAmount: toNumber(itemRecord.priceOriginalAmount),
            priceOriginalCurrency: toText(itemRecord.priceOriginalCurrency) || null,
            priceConvertedAmount: toNumber(itemRecord.priceConvertedAmount),
            priceExchangeRate: toNumber(itemRecord.priceExchangeRate),
            priceRateTimestamp: toText(itemRecord.priceRateTimestamp) || null,
            actualCost: toNumber(itemRecord.actualCost),
            travelMinutes: toNumber(itemRecord.travelMinutes),
            transportation: toText(itemRecord.transportation),
            actualTransportation: toText(itemRecord.actualTransportation),
            openingHours: toText(itemRecord.openingHours),
            mapLink: toText(itemRecord.mapLink),
            lat: toNumber(itemRecord.lat),
            lon: toNumber(itemRecord.lon),
            alternativeSuggestion: toText(itemRecord.alternativeSuggestion),
            bookingWarning: toText(itemRecord.bookingWarning),
            plannedNotes: toText(itemRecord.plannedNotes),
            journalNotes: toText(itemRecord.journalNotes),
            recommendationId: toText(itemRecord.recommendationId) || null,
            reservationRequired: Boolean(itemRecord.reservationRequired),
            bookingCompleted: Boolean(itemRecord.bookingCompleted),
            optional: Boolean(itemRecord.optional),
            locked: Boolean(itemRecord.locked),
            completed: Boolean(itemRecord.completed),
            completedAt: toText(itemRecord.completedAt) || null,
            skipped: Boolean(itemRecord.skipped),
            skippedAt: toText(itemRecord.skippedAt) || null,
            skipReason: toText(itemRecord.skipReason) || null,
            spontaneous: Boolean(itemRecord.spontaneous),
            personalRating: toNumber(itemRecord.personalRating),
            wouldVisitAgain:
              typeof itemRecord.wouldVisitAgain === "boolean" ? itemRecord.wouldVisitAgain : null,
            actualDurationMinutes: toNumber(itemRecord.actualDurationMinutes),
          };
        })
      : [];

    return {
      ...baseDay,
      ...dayRecord,
      id: toText(dayRecord.id) || baseDay.id,
      dayNumber: toNumber(dayRecord.dayNumber) ?? index + 1,
      title: toText(dayRecord.title) || baseDay.title,
      date: toText(dayRecord.date),
      cityRegion: toText(dayRecord.cityRegion),
      accommodation: toText(dayRecord.accommodation),
      accommodationMapLink: toText(dayRecord.accommodationMapLink),
      accommodationLat: toNumber(dayRecord.accommodationLat),
      accommodationLon: toNumber(dayRecord.accommodationLon),
      notes: toText(dayRecord.notes),
      transportation: toText(dayRecord.transportation),
      estimatedCost: toNumber(dayRecord.estimatedCost),
      activityCost: toNumber(dayRecord.activityCost),
      foodCost: toNumber(dayRecord.foodCost),
      transportCost: toNumber(dayRecord.transportCost),
      accommodationCost: toNumber(dayRecord.accommodationCost),
      totalTravelMinutes: toNumber(dayRecord.totalTravelMinutes),
      warnings: toStringArray(dayRecord.warnings),
      alternatives: toStringArray(dayRecord.alternatives),
      bookingRequirements: toStringArray(dayRecord.bookingRequirements),
      safetyNotes: toStringArray(dayRecord.safetyNotes),
      restWindow: toText(dayRecord.restWindow),
      transportSegments: toStringArray(dayRecord.transportSegments),
      favoriteMoment: toText(dayRecord.favoriteMoment),
      dayEndNote: toText(dayRecord.dayEndNote),
      dayCompletedAt: toText(dayRecord.dayCompletedAt) || null,
      items,
    };
  });
}

function normalizeExpenseList(value: unknown): TripExpense[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      id: toText(item.id),
      category:
        item.category === "accommodation" ||
        item.category === "food" ||
        item.category === "attractions" ||
        item.category === "local_transportation" ||
        item.category === "flights" ||
        item.category === "shopping"
          ? item.category
          : "other",
      label: toText(item.label),
      amount: toNumber(item.amount) ?? 0,
      amountOriginalCurrency: toText(item.amountOriginalCurrency) || null,
      exchangeRate: toNumber(item.exchangeRate),
      rateTimestamp: toText(item.rateTimestamp) || null,
      date: toText(item.date),
      dayId: toText(item.dayId) || null,
      itemId: toText(item.itemId) || null,
      notes: toText(item.notes),
    }));
}

function normalizeCostSummary(
  value: unknown,
  daysCount: number,
  travelers: number
): ItineraryCostSummary {
  const record = isRecord(value) ? value : {};
  const categoryBreakdown = isRecord(record.categoryBreakdown)
    ? Object.fromEntries(
        Object.entries(record.categoryBreakdown)
          .map(([key, amount]) => [key, toNumber(amount) ?? 0] as const)
          .filter(([, amount]) => amount > 0)
      )
    : {};

  const totalEstimatedCost = toNumber(record.totalEstimatedCost);

  return {
    totalEstimatedCost,
    estimatedTransportCost: toNumber(record.estimatedTransportCost),
    averageDailyCost:
      toNumber(record.averageDailyCost) ??
      (totalEstimatedCost != null && daysCount > 0 ? Math.round(totalEstimatedCost / daysCount) : null),
    costPerTraveler:
      toNumber(record.costPerTraveler) ??
      (totalEstimatedCost != null && travelers > 0 ? Math.round(totalEstimatedCost / travelers) : null),
    categoryBreakdown,
  };
}

export function buildSuggestedItineraryTitle(
  countryName: string,
  startDate: string | null | undefined,
  endDate: string | null | undefined
) {
  return `${countryName}: ${formatTripDateRange(startDate, endDate)}`;
}

/**
 * Dates drive status when known. When they're not (e.g. a historical trip
 * whose exact dates haven't been entered yet), `fallbackStatus` is used
 * instead of forcing "draft" — otherwise an already-completed historical
 * record would flip to "draft" the moment it's read back or re-saved.
 */
export function deriveItineraryStatus(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  archived: boolean,
  fallbackStatus: CountryItineraryStatus = "draft",
  isoA2: string | null = null,
  now: Date = new Date()
): CountryItineraryStatus {
  if (archived) return "archived";
  if (!startDate || !endDate) return fallbackStatus;
  // Destination-local calendar date when we know the country (real trips
  // always do); falls back to the runtime's own local date only when no
  // country context is available at all.
  const today = isoA2 ? getDestinationDateString(isoA2, now) : format(now, "yyyy-MM-dd");
  if (endDate < today) return "completed";
  if (startDate > today) return "upcoming";
  return "active";
}

const VALID_ITINERARY_STATUSES: readonly CountryItineraryStatus[] = [
  "draft",
  "upcoming",
  "active",
  "completed",
  "archived",
];

export function normalizeItineraryStatus(value: string): CountryItineraryStatus {
  return (VALID_ITINERARY_STATUSES as readonly string[]).includes(value)
    ? (value as CountryItineraryStatus)
    : "draft";
}

export function computeItineraryCostSummary(
  workspace: Pick<CountryTripWorkspaceState, "itineraryDays" | "estimatedExpenses" | "preferences" | "bookings">
): ItineraryCostSummary {
  return summarizeItemCosts(
    applyBookingOverrides(workspace.itineraryDays, workspace.bookings),
    workspace.preferences.travelers,
    [...normalizeExpenseList(workspace.estimatedExpenses), ...flightCostExpenses(workspace.preferences.flights)]
  );
}

export function createWorkspaceFromItineraryRecord(
  itinerary: CountryItineraryRecord,
  countryName: string
) {
  const snapshot = isRecord(itinerary.workspaceSnapshot) ? itinerary.workspaceSnapshot : {};
  const merged: CountryTripWorkspaceState = {
    ...createDefaultWorkspace(countryName),
    ...(snapshot as Partial<CountryTripWorkspaceState>),
    preferences: itinerary.preferencesSnapshot,
    itineraryDays: itinerary.itineraryDays,
    lastAiPlanSummary: itinerary.summary,
  };

  return normalizeWorkspace(merged, countryName);
}

export function normalizeCountryItineraryRow(row: Tables<"country_itineraries">): CountryItineraryRecord {
  const preferencesSnapshot = normalizeTripPreferences(row.preferences_snapshot);
  const itineraryDays = normalizeItineraryDays(row.itinerary_days);
  const daysCount =
    row.days_count > 0
      ? row.days_count
      : itineraryDays.length > 0
        ? itineraryDays.length
        : getTripDayCount(row.start_date ?? "", row.end_date ?? "", 0);

  const generationMode = row.generation_mode as ItineraryGenerationMode;
  const normalizedMode: ItineraryGenerationMode =
    generationMode === "balanced" ||
    generationMode === "cheapest" ||
    generationMode === "fastest" ||
    generationMode === "relaxed" ||
    generationMode === "intensive" ||
    generationMode === "family_friendly" ||
    generationMode === "walking_friendly" ||
    generationMode === "safer_route"
      ? generationMode
      : "balanced";

  return {
    id: row.id,
    countryId: row.country_id,
    isoA2: row.iso_a2,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    daysCount,
    travelers: row.travelers,
    budget: row.budget,
    generationMode: normalizedMode,
    source:
      row.source === "manual" || row.source === "historical_manual" ? row.source : "ai",
    model: row.model,
    summary: row.summary ?? "",
    preferencesSnapshot,
    workspaceSnapshot: isRecord(row.workspace_snapshot)
      ? (row.workspace_snapshot as Partial<CountryTripWorkspaceState>)
      : null,
    itineraryDays,
    costSummary: normalizeCostSummary(row.cost_summary, daysCount, row.travelers),
    status: deriveItineraryStatus(
      row.start_date,
      row.end_date,
      row.archived,
      normalizeItineraryStatus(row.status),
      row.iso_a2
    ),
    version: row.version,
    parentItineraryId: row.parent_itinerary_id,
    manuallyEdited: row.manually_edited,
    archived: row.archived,
    generatedAt: row.generated_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeCountryItineraryVersionRow(
  row: Tables<"country_itinerary_versions">
): CountryItineraryVersionRecord {
  let snapshot: CountryItineraryRecord | null = null;
  if (isRecord(row.snapshot)) {
    const value = row.snapshot as Partial<CountryItineraryRecord>;
    if (value.id && value.countryId) {
      snapshot = value as CountryItineraryRecord;
    }
  }

  return {
    id: row.id,
    itineraryId: row.itinerary_id,
    version: row.version,
    changeReason: row.change_reason,
    source:
      row.source === "manual" ||
      row.source === "duplicate" ||
      row.source === "restore" ||
      row.source === "regenerate"
        ? row.source
        : "ai",
    model: row.model,
    snapshot,
    restoredFromVersionId: row.restored_from_version_id,
    createdAt: row.created_at,
  };
}

export function formatItineraryVersionLabel(version: number, createdAt: string) {
  const parsed = parseISO(createdAt);
  const suffix = isValid(parsed) ? format(parsed, "d בMMM yyyy, HH:mm", { locale: he }) : createdAt;
  return `גרסה ${version} · ${suffix}`;
}

export function buildCountryItinerarySuccessPayload(
  itinerary: CountryItineraryRecord,
  countryName: string
): CountryItineraryGenerationSuccessPayload {
  return {
    itineraryId: itinerary.id,
    countryCode: itinerary.isoA2,
    countryName,
    startDate: itinerary.startDate,
    endDate: itinerary.endDate,
    totalDays: itinerary.daysCount,
    estimatedTotalCost: itinerary.costSummary.totalEstimatedCost,
    status: itinerary.status,
  };
}
