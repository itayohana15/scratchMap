import countryFactsData from "@/lib/facts/country-facts-data.json";
import type { TripHubCountry, TripHubTrip } from "@/lib/trip-hub";
import type { Status } from "@/lib/supabase/types";

interface RawCountryFactsRecord {
  region?: string;
}

export function continentForIso(isoA2: string): string | null {
  const record = (countryFactsData as Record<string, RawCountryFactsRecord>)[isoA2.toUpperCase()];
  return record?.region?.trim() || null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface CountryTripGroup {
  isoA2: string;
  country: TripHubCountry | null;
  countryName: string;
  trips: TripHubTrip[];
  completedTrips: TripHubTrip[];
  visitYears: string[];
  isUpcoming: boolean;
  isActive: boolean;
}

/**
 * The single grouping primitive everything else builds on — one entry per
 * ISO country, never per itinerary row (spec §28/§43: Sinai 2022 + Sinai
 * 2023 both carry iso_a2="EG" and land in the same group here).
 */
export function groupTripsByCountry(trips: TripHubTrip[]): Map<string, CountryTripGroup> {
  const groups = new Map<string, CountryTripGroup>();

  for (const trip of trips) {
    const key = trip.isoA2.toUpperCase();
    const existing = groups.get(key);
    const group: CountryTripGroup =
      existing ?? {
        isoA2: key,
        country: trip.country,
        countryName: trip.countryName,
        trips: [],
        completedTrips: [],
        visitYears: [],
        isUpcoming: false,
        isActive: false,
      };

    group.trips.push(trip);
    if (trip.status === "completed") {
      group.completedTrips.push(trip);
      if (trip.year && !group.visitYears.includes(trip.year)) group.visitYears.push(trip.year);
    }
    if (trip.status === "upcoming" || trip.status === "planning") group.isUpcoming = true;
    if (trip.status === "active") group.isActive = true;

    groups.set(key, group);
  }

  for (const group of groups.values()) group.visitYears.sort();
  return groups;
}

export interface PassportStats {
  countriesVisited: number;
  tripsCompleted: number;
  continents: number;
  citiesVisited: { value: number; isPartial: boolean };
  knownTravelDays: { value: number; isPartial: boolean };
}

/** Completed trips only — the one definition of "trip history" reused everywhere (Dashboard/Trips/Passport). */
export function getCompletedTrips(trips: TripHubTrip[]): TripHubTrip[] {
  return trips.filter((trip) => trip.status === "completed");
}

/** Upcoming trips only, nearest first. */
export function getUpcomingTrips(trips: TripHubTrip[]): TripHubTrip[] {
  return trips.filter((trip) => trip.status === "upcoming").sort((a, b) => a.sortDate.localeCompare(b.sortDate));
}

/** Deterministic only (spec §33/§45) — no AI involved in any of these counts. */
export function computePassportStats(trips: TripHubTrip[]): PassportStats {
  const completed = getCompletedTrips(trips);
  const visitedIsoCodes = new Set(completed.map((trip) => trip.isoA2.toUpperCase()));

  const continents = new Set<string>();
  for (const iso of visitedIsoCodes) {
    const continent = continentForIso(iso);
    if (continent) continents.add(continent);
  }

  // A historical trip with itineraryDays: [] genuinely has no recorded
  // cities (not "0 cities visited" — it was just never tracked). Only trips
  // with real day data contribute to the count; isPartial flags when some
  // completed trips were excluded, so the UI can show "—"/"not tracked"
  // instead of a misleading 0.
  const cities = new Set<string>();
  let hasUntrackedTrip = false;
  for (const trip of completed) {
    if (trip.itinerary.itineraryDays.length === 0) {
      hasUntrackedTrip = true;
      continue;
    }
    for (const city of trip.visitedCityNames) {
      const trimmed = city.trim();
      if (trimmed) cities.add(trimmed.toLowerCase());
    }
  }

  const knownDurationTrips = completed.filter((trip) => trip.daysCount > 0);
  const knownTravelDays = knownDurationTrips.reduce((sum, trip) => sum + trip.daysCount, 0);
  const isPartial = knownDurationTrips.length < completed.length;

  return {
    countriesVisited: visitedIsoCodes.size,
    tripsCompleted: completed.length,
    continents: continents.size,
    citiesVisited: { value: cities.size, isPartial: hasUntrackedTrip },
    knownTravelDays: { value: knownTravelDays, isPartial },
  };
}

/** Trip count by country, not by itinerary-row join — spec §35's exact requirement. */
export function mostVisitedCountry(trips: TripHubTrip[]): { isoA2: string; countryName: string; tripCount: number } | null {
  const groups = groupTripsByCountry(trips.filter((trip) => trip.status === "completed"));
  let best: CountryTripGroup | null = null;
  for (const group of groups.values()) {
    if (!best || group.completedTrips.length > best.completedTrips.length) best = group;
  }
  return best ? { isoA2: best.isoA2, countryName: best.countryName, tripCount: best.completedTrips.length } : null;
}

export function mostVisitedCity(trips: TripHubTrip[]): { city: string; tripCount: number } | null {
  const counts = new Map<string, number>();
  for (const trip of trips) {
    if (trip.status !== "completed") continue;
    for (const city of new Set(trip.visitedCityNames.map((c) => c.trim()).filter(Boolean))) {
      counts.set(city, (counts.get(city) ?? 0) + 1);
    }
  }
  let best: [string, number] | null = null;
  for (const entry of counts.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best ? { city: best[0], tripCount: best[1] } : null;
}

/** Only trips with a known duration are eligible — an unknown-duration historical trip never wins by default (spec §44). */
export function longestKnownTrip(trips: TripHubTrip[]): TripHubTrip | null {
  const known = trips.filter((trip) => trip.status === "completed" && trip.daysCount > 0);
  if (known.length === 0) return null;
  return known.reduce((best, trip) => (trip.daysCount > best.daysCount ? trip : best));
}

export function mostActiveYear(trips: TripHubTrip[]): { year: string; tripCount: number } | null {
  const counts = new Map<string, number>();
  for (const trip of trips) {
    if (trip.status !== "completed" || !trip.year) continue;
    counts.set(trip.year, (counts.get(trip.year) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of counts.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best ? { year: best[0], tripCount: best[1] } : null;
}

export function firstRecordedTrip(trips: TripHubTrip[]): TripHubTrip | null {
  const completed = trips.filter((trip) => trip.status === "completed");
  if (completed.length === 0) return null;
  return completed.reduce((earliest, trip) => (trip.sortDate < earliest.sortDate ? trip : earliest));
}

export function mostRecentTrip(trips: TripHubTrip[]): TripHubTrip | null {
  const completed = trips.filter((trip) => trip.status === "completed");
  if (completed.length === 0) return null;
  return completed.reduce((latest, trip) => (trip.sortDate > latest.sortDate ? trip : latest));
}

export interface FavoriteCountry {
  isoA2: string;
  countryName: string;
  averageRating: number;
  ratedTripCount: number;
}

/** Only countries with at least one explicit completed-trip rating are ranked (spec §36) — never 0 for unrated. */
export function favoriteCountries(
  trips: TripHubTrip[],
  overallRatingByItineraryId: Map<string, number | null>
): FavoriteCountry[] {
  const groups = groupTripsByCountry(trips);
  const result: FavoriteCountry[] = [];

  for (const group of groups.values()) {
    const ratings = group.completedTrips
      .map((trip) => overallRatingByItineraryId.get(trip.id))
      .filter((value): value is number => value != null);
    const avg = average(ratings);
    if (avg == null) continue;
    result.push({ isoA2: group.isoA2, countryName: group.countryName, averageRating: avg, ratedTripCount: ratings.length });
  }

  return result.sort((a, b) => b.averageRating - a.averageRating);
}

export interface TimelineEntry {
  trip: TripHubTrip;
  year: string;
  sortKey: string;
}

/**
 * Chronological, stable-sorted using each trip's own sortDate (exact date,
 * else partial-date "YYYY-MM", else createdAt — see trip-hub.ts's
 * effectiveSortDate) — never invents a missing date (spec §32).
 */
export function buildGlobalTimeline(trips: TripHubTrip[]): TimelineEntry[] {
  return trips
    .filter((trip) => trip.status === "completed")
    .map((trip) => ({ trip, year: trip.year, sortKey: trip.sortDate }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/**
 * Spec "MAP COUNTRY STATUS MUST BE DERIVED FROM TRIPS" — the ONE
 * authoritative rule for a single country's travel status, reused by
 * every surface that shows one (map fill, sidebar, filters, country
 * detail panel, dashboard counts). Root-cause fix: `countries.status` is
 * a manually-set DB column with exactly three write paths (a status
 * dropdown, a generic upsert, and an auto-insert on first `/countries/
 * [iso]` visit) and ZERO trip-driven writers — creating, deleting, or
 * editing a trip never touches it, so it silently drifts from reality.
 * This function is the fix: status is never stored, always recomputed
 * from the trip list actually in hand.
 *
 * Rules (spec, verbatim):
 *  - VISITED: at least one trip that has started — trip.startDate <=
 *    today (today's local/destination calendar date, not a UTC
 *    timestamp), OR a trip already known complete/active/archived-after-
 *    starting regardless of a parseable date. Reuses TripHubTrip.hasStarted
 *    (trip-hub.ts), which already implements exactly this predicate
 *    (status==="completed" || status==="active" ||
 *    Boolean(startDate && startDate<=today)) against the SAME
 *    destination-local date every other itinerary-status computation in
 *    this codebase uses (getDestinationDateString) — never a second,
 *    competing date system. A trip starting exactly today is VISITED
 *    (startDate<=today), never "planned".
 *  - PLANNED: no started trip, but at least one trip exists at all
 *    (a future-dated trip, or one with no date yet — "in planning" still
 *    means a real trip exists).
 *  - NOT_VISITED: no trips for this country at all.
 *  - Precedence VISITED > PLANNED > NOT_VISITED — a later, future trip to
 *    an already-visited country can never downgrade it.
 */
export function deriveCountryTravelStatus(trips: Pick<TripHubTrip, "hasStarted">[]): Status {
  if (trips.length === 0) return "not_visited";
  if (trips.some((trip) => trip.hasStarted)) return "visited";
  return "planned";
}

/**
 * All-countries-at-once version of deriveCountryTravelStatus, grouped by
 * canonical ISO A2 (never by display name — Hebrew/English labels for the
 * same country must never create separate identities). "Currently
 * traveling" is intentionally NOT a 4th map color (would require a DB enum
 * migration touching unrelated country-CRUD UI); it's surfaced separately
 * as a banner/link.
 */
export function deriveCountryMapStatuses(trips: TripHubTrip[]): Record<string, Status> {
  const tripsByIso = new Map<string, TripHubTrip[]>();
  for (const trip of trips) {
    const iso = trip.isoA2.toUpperCase();
    const existing = tripsByIso.get(iso);
    if (existing) existing.push(trip);
    else tripsByIso.set(iso, [trip]);
  }

  const statuses: Record<string, Status> = {};
  for (const [iso, isoTrips] of tripsByIso) {
    statuses[iso] = deriveCountryTravelStatus(isoTrips);
  }
  return statuses;
}
