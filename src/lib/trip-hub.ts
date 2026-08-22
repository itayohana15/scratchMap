import { differenceInCalendarDays, parseISO } from "date-fns";

import {
  createWorkspaceFromItineraryRecord,
  type CountryItineraryRecord,
  type CountryItineraryStatus,
} from "@/lib/itineraries";
import type { Status } from "@/lib/supabase/types";
import {
  buildTripComparison,
  buildTripStatistics,
  type CountryTripWorkspaceState,
  type TripComparison,
  type TripItineraryDay,
  type TripItineraryItem,
  type TripStatistics,
} from "@/lib/trip-workspace";

export const TRIP_HUB_TODAY = "2026-08-19";

export type TripHubStatus = "planning" | "upcoming" | "active" | "completed" | "archived";
export type TripDurationFilter = "all" | "short" | "medium" | "long" | "extended";

export interface TripHubCountry {
  id: string;
  name: string;
  isoA2: string;
  status: Status;
}

export interface TripHubTrip {
  id: string;
  itinerary: CountryItineraryRecord;
  country: TripHubCountry | null;
  countryName: string;
  isoA2: string;
  title: string;
  status: TripHubStatus;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  year: string;
  daysCount: number;
  travelers: number;
  budget: number | null;
  estimatedCost: number | null;
  actualCost: number | null;
  displayCost: number | null;
  workspace: CountryTripWorkspaceState;
  statistics: TripStatistics;
  comparison: TripComparison;
  routeCities: string[];
  visitedCityNames: string[];
  routePreviewCities: string[];
  cityCount: number;
  countdownDays: number | null;
  currentDayNumber: number | null;
  visitedDayCount: number;
  currentDay: TripItineraryDay | null;
  nextActivity: TripItineraryItem | null;
  planningCompletionPercentage: number | null;
  itineraryDaysGenerated: number;
  totalBookings: number;
  confirmedBookings: number;
  transportBookingsTotal: number;
  transportBookingsConfirmed: number;
  reservationCount: number;
  reservationCompletedCount: number;
  accommodationConfiguredDays: number;
  journalCount: number;
  photoCount: number;
  personalRating: number | null;
  hasStarted: boolean;
  hasAnyActualData: boolean;
  tripStyle: string | null;
  isHistorical: boolean;
  /** Best-known date for sorting; see `effectiveSortDate`. */
  sortDate: string;
}

export const TRIP_HUB_STATUS_LABELS: Record<TripHubStatus, string> = {
  planning: "בתכנון",
  upcoming: "קרוב",
  active: "במהלך הטיול",
  completed: "הושלם",
  archived: "בארכיון",
};

export const TRIP_DURATION_LABELS: Record<Exclude<TripDurationFilter, "all">, string> = {
  short: "עד 4 ימים",
  medium: "5–9 ימים",
  long: "10–20 ימים",
  extended: "21+ ימים",
};

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function isMeaningfulText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function mapItineraryStatus(status: CountryItineraryStatus): TripHubStatus {
  switch (status) {
    case "draft":
      return "planning";
    case "upcoming":
      return "upcoming";
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "archived":
      return "archived";
  }
}

/**
 * A trip's best-known date for sorting/grouping: real start date when
 * known, else the "YYYY-MM" partialDate (for historical trips with only a
 * known month), else its createdAt as a last resort.
 */
export function effectiveSortDate(itinerary: CountryItineraryRecord) {
  if (itinerary.startDate) return itinerary.startDate;
  if (itinerary.endDate) return itinerary.endDate;
  const partial = itinerary.preferencesSnapshot.partialDate;
  if (isMeaningfulText(partial)) return `${partial.trim()}-01`;
  return itinerary.createdAt;
}

/** True when the trip's date is exactly known (not just a "YYYY-MM" guess or createdAt fallback). */
export function hasExactDate(itinerary: CountryItineraryRecord) {
  return Boolean(itinerary.startDate);
}

function determineYear(itinerary: CountryItineraryRecord) {
  return effectiveSortDate(itinerary).slice(0, 4);
}

function determineActualCost(workspace: CountryTripWorkspaceState) {
  const actualExpenseTotal = workspace.actualExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  if (actualExpenseTotal > 0) return actualExpenseTotal;

  const actualItemTotal = workspace.itineraryDays
    .flatMap((day) => day.items)
    .reduce((sum, item) => sum + (item.actualCost ?? 0), 0);

  return actualItemTotal > 0 ? actualItemTotal : null;
}

function determineEstimatedCost(itinerary: CountryItineraryRecord, workspace: CountryTripWorkspaceState) {
  const estimatedExpenseTotal = workspace.estimatedExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  if (estimatedExpenseTotal > 0) return estimatedExpenseTotal;
  if (itinerary.costSummary.totalEstimatedCost != null) return itinerary.costSummary.totalEstimatedCost;
  return itinerary.budget;
}

function determinePlanningCompletion(itinerary: CountryItineraryRecord, days: TripItineraryDay[]) {
  const targetDays = Math.max(itinerary.daysCount, days.length, 1);
  const plannedDays = days.filter(
    (day) =>
      isMeaningfulText(day.cityRegion) ||
      isMeaningfulText(day.accommodation) ||
      isMeaningfulText(day.title) ||
      day.items.some((item) => isMeaningfulText(item.name))
  ).length;

  if (targetDays <= 0) return null;
  return Math.round((plannedDays / targetDays) * 100);
}

function determineCurrentDay(
  status: TripHubStatus,
  startDate: string | null,
  days: TripItineraryDay[]
) {
  if (status !== "active" || !startDate) {
    return { currentDayNumber: null, currentDay: null, visitedDayCount: status === "completed" ? days.length : 0 };
  }

  const currentDayNumber = Math.max(
    differenceInCalendarDays(parseISO(TRIP_HUB_TODAY), parseISO(startDate)) + 1,
    1
  );
  const currentDay =
    days.find((day) => day.date === TRIP_HUB_TODAY) ??
    days.find((day) => day.dayNumber === currentDayNumber) ??
    null;

  return {
    currentDayNumber,
    currentDay,
    visitedDayCount: Math.min(currentDayNumber, Math.max(days.length, currentDayNumber)),
  };
}

function determineNextActivity(day: TripItineraryDay | null) {
  if (!day) return null;
  return (
    day.items.find((item) => isMeaningfulText(item.name) && !item.completed && !item.skipped) ??
    day.items.find((item) => isMeaningfulText(item.name)) ??
    null
  );
}

function determineVisitedCities(status: TripHubStatus, days: TripItineraryDay[]) {
  if (status === "planning" || status === "upcoming") return [];

  if (status === "active") {
    return uniqueStrings(
      days
        .filter((day) => !day.date || day.date <= TRIP_HUB_TODAY)
        .map((day) => day.cityRegion)
    );
  }

  return uniqueStrings(days.map((day) => day.cityRegion));
}

function determineCountdownDays(status: TripHubStatus, startDate: string | null) {
  if (status !== "upcoming" || !startDate) return null;
  return Math.max(differenceInCalendarDays(parseISO(startDate), parseISO(TRIP_HUB_TODAY)), 0);
}

function determineJournalCount(workspace: CountryTripWorkspaceState) {
  return workspace.journalEntries.filter(
    (entry) => isMeaningfulText(entry.title) || isMeaningfulText(entry.text)
  ).length;
}

function determineAccommodationConfiguredDays(days: TripItineraryDay[]) {
  return days.filter((day) => isMeaningfulText(day.accommodation)).length;
}

function determineRouteCities(days: TripItineraryDay[], fallbackCountryName: string) {
  const routeCities = uniqueStrings(days.map((day) => day.cityRegion));
  return routeCities.length > 0 ? routeCities : [fallbackCountryName];
}

function determineReservations(days: TripItineraryDay[]) {
  const reservableItems = days.flatMap((day) => day.items).filter((item) => item.reservationRequired);
  return {
    total: reservableItems.length,
    completed: reservableItems.filter((item) => item.bookingCompleted).length,
  };
}

function determineTransportBookings(workspace: CountryTripWorkspaceState) {
  const transportBookings = workspace.bookings.filter(
    (booking) => booking.type === "flight" || booking.type === "transport"
  );

  return {
    total: transportBookings.length,
    confirmed: transportBookings.filter(
      (booking) => booking.status === "confirmed" || booking.status === "completed"
    ).length,
  };
}

export function getTripDurationBucket(daysCount: number): Exclude<TripDurationFilter, "all"> {
  if (daysCount <= 4) return "short";
  if (daysCount <= 9) return "medium";
  if (daysCount <= 20) return "long";
  return "extended";
}

export function getTripHubYear(trip: TripHubTrip) {
  return trip.year;
}

export function buildTripHubTrip(
  itinerary: CountryItineraryRecord,
  country: TripHubCountry | null,
  photoCountOverride?: number
): TripHubTrip {
  const countryName = country?.name ?? itinerary.isoA2.toUpperCase();
  const workspace = createWorkspaceFromItineraryRecord(itinerary, countryName);
  const status = mapItineraryStatus(itinerary.status);
  const destinationFallback = isMeaningfulText(workspace.preferences.accommodationArea)
    ? workspace.preferences.accommodationArea.trim()
    : countryName;
  const routeCities = determineRouteCities(workspace.itineraryDays, destinationFallback);
  const visitedCityNames = determineVisitedCities(status, workspace.itineraryDays);
  const { currentDayNumber, currentDay, visitedDayCount } = determineCurrentDay(
    status,
    itinerary.startDate,
    workspace.itineraryDays
  );
  const nextActivity = determineNextActivity(currentDay);
  const reservations = determineReservations(workspace.itineraryDays);
  const transportBookings = determineTransportBookings(workspace);
  const estimatedCost = determineEstimatedCost(itinerary, workspace);
  const actualCost = determineActualCost(workspace);
  const statistics = buildTripStatistics(workspace);
  const comparison = buildTripComparison(workspace);
  const hasStarted =
    status === "completed" ||
    status === "active" ||
    Boolean(itinerary.startDate && itinerary.startDate <= TRIP_HUB_TODAY);

  return {
    id: itinerary.id,
    itinerary,
    country,
    countryName,
    isoA2: itinerary.isoA2,
    title: itinerary.title,
    status,
    startDate: itinerary.startDate,
    endDate: itinerary.endDate,
    createdAt: itinerary.createdAt,
    updatedAt: itinerary.updatedAt,
    year: determineYear(itinerary),
    daysCount: itinerary.daysCount,
    travelers: itinerary.travelers,
    budget: itinerary.budget,
    estimatedCost,
    actualCost,
    displayCost: actualCost ?? estimatedCost ?? itinerary.budget,
    workspace,
    statistics,
    comparison,
    routeCities,
    visitedCityNames,
    routePreviewCities: routeCities.slice(0, 4),
    cityCount: routeCities.length,
    countdownDays: determineCountdownDays(status, itinerary.startDate),
    currentDayNumber,
    visitedDayCount:
      status === "completed" || (status === "archived" && hasStarted)
        ? itinerary.daysCount
        : visitedDayCount,
    currentDay,
    nextActivity,
    planningCompletionPercentage: determinePlanningCompletion(itinerary, workspace.itineraryDays),
    itineraryDaysGenerated: workspace.itineraryDays.length,
    totalBookings: workspace.bookings.length,
    confirmedBookings: workspace.bookings.filter(
      (booking) => booking.status === "confirmed" || booking.status === "completed"
    ).length,
    transportBookingsTotal: transportBookings.total,
    transportBookingsConfirmed: transportBookings.confirmed,
    reservationCount: reservations.total,
    reservationCompletedCount: reservations.completed,
    accommodationConfiguredDays: determineAccommodationConfiguredDays(workspace.itineraryDays),
    journalCount: determineJournalCount(workspace),
    photoCount: photoCountOverride ?? 0,
    personalRating: workspace.summary.personalRating,
    hasStarted,
    hasAnyActualData:
      (actualCost ?? 0) > 0 ||
      statistics.completedActivities > 0 ||
      determineJournalCount(workspace) > 0 ||
      (photoCountOverride ?? 0) > 0,
    tripStyle: isMeaningfulText(itinerary.preferencesSnapshot.tripStyle)
      ? itinerary.preferencesSnapshot.tripStyle.trim()
      : null,
    isHistorical: itinerary.source === "historical_manual",
    sortDate: effectiveSortDate(itinerary),
  };
}
