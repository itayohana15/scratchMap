// Pure, client-safe presentation helpers behind the redesigned itinerary
// day screen (trip-itinerary-tab.tsx) — extracted specifically so this
// logic is unit-testable (this repo has no React-rendering test
// framework; every existing test is a node:test against a pure function,
// same convention as hotel-ui-helpers.ts/food-ui-helpers.ts). Never
// itinerary-planning logic — purely how to label/summarize already-
// generated data for display.
import {
  estimateTravelMinutes,
  haversineKm,
  isMealOpportunityMarker,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}:${String(rest).padStart(2, "0")} שעות` : `${hours} שעות`;
}

/**
 * Presentation-only day-type classification (spec B3 "secondary line") —
 * reads the same transfer/day-trip wording the generator itself already
 * writes into title/notes/transportation. Never a planning decision.
 */
export function deriveDayTypeLabel(day: Pick<TripItineraryDay, "title" | "notes" | "transportation">): string | null {
  const text = `${day.title} ${day.notes} ${day.transportation}`;
  if (/יום מעבר|מעבר בין בסיסים|transfer day/i.test(text)) return "יום מעבר";
  if (/יום טיול|טיול יום|day trip/i.test(text)) return "טיול יום";
  return null;
}

export function isRealPlaceItem(
  item: Pick<TripItineraryItem, "category" | "lat" | "lon" | "recommendationId">
): boolean {
  return !isMealOpportunityMarker(item) && item.category !== "transportation" && item.category !== "practical";
}

export interface DaySummary {
  totalTravelMinutes: number;
  placeCount: number;
  foodWindowCount: number;
}

export function computeDaySummary(day: Pick<TripItineraryDay, "items">): DaySummary {
  const totalTravelMinutes = day.items.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);
  const placeCount = day.items.filter((item) => isRealPlaceItem(item)).length;
  const foodWindowCount = day.items.filter((item) => item.category === "restaurant" || item.category === "cafe").length;
  return { totalTravelMinutes, placeCount, foodWindowCount };
}

/** Spec B9 — whether a travel connector has anything real to show; never render an empty connector row. */
export function shouldShowTravelConnector(item: Pick<TripItineraryItem, "travelMinutes" | "transportation">): boolean {
  return Boolean(item.travelMinutes || item.transportation);
}

/**
 * Spec B4/B5 — the day to navigate to from the current selection, or null
 * at either end of the trip. One shared implementation for both the
 * desktop rail's prev/next buttons and the mobile prev/next buttons
 * (spec "day rail handles >10 days" — works identically regardless of
 * trip length).
 */
export function getAdjacentDayId(
  days: Array<{ id: string }>,
  selectedDayId: string,
  direction: -1 | 1
): string | null {
  const index = days.findIndex((day) => day.id === selectedDayId);
  if (index === -1) return null;
  const target = days[index + direction];
  return target ? target.id : null;
}

// --- Mechanical geography diagnostics (QA_DEBUG_GEOGRAPHY overlay) --------
//
// Renders, on an already-SAVED trip, the same kind of per-item/per-day
// geography table computeGeographyDiagnostics produces at generation time
// in country-itinerary-generation.ts — but this is a genuinely DEGRADED
// version, not a client port of that function, because a saved
// TripItineraryDay/TripItineraryItem never carries the generation-time
// context (TripFrame, the real candidate pool, flight legs) that function
// reads:
//  - geoSource here can only ever be "provider" (lat/lon present) or
//    "unresolved" (absent) — the richer recommendationId/fuzzyName
//    distinction requires the resolution history from generation time,
//    which is never persisted onto the saved trip (and the "no schema
//    change" rule this overlay was built under keeps it that way on
//    purpose). The one exception: an optional geoResolutionOverride map
//    (see GeoResolutionOverrideMap below), loaded from a real
//    CAPTURE_FIXTURES=1 run's geo-resolution.json when one happens to
//    exist for this trip's country — when an item has a matching entry
//    there, its real geoSource value is used instead of the degraded
//    guess. Absent that file (the normal case), behavior is unchanged.
//  - derivedDayType here is a JIT approximation from persisted fields
//    only: arrival/departure from trip-edge position (no real flight-leg
//    dates on this type), transfer from a REAL structural signal
//    (cityCanonicalId changing from the previous day — the persisted
//    analogue of the server's stayId comparison), day_trip from the same
//    round-trip geometry check the server uses. It is not a client copy
//    of deriveDayType and can disagree with it near arrival/departure
//    edges — that gap is deliberate and disclosed, not a bug to fix here.
// textualDayType intentionally mirrors the server's isDayTripDay/
// isIntercityTransferDay regexes verbatim (duplicated, not imported —
// those live in lib/server/*, off-limits to a client bundle) so the two
// numbers shown side by side are the same comparison the server-side
// investigation already made, not a third, different classifier.

const DEBUG_TRANSFER_DAY_PATTERN =
  /intercity|transfer|relocation|checkout|check-out|check in|check-in|airport|flight|bullet train|shinkansen|long-distance|ferry crossing|move to next city|road trip|stops? along the way|scenic drive|מעבר|רכבת מהירה|רכבת בין-עירונית|שינקנסן|טיסה|צ'ק-אאוט|צ'ק אאוט|צ'ק-אין|צ'ק אין|שדה תעופה|מעבורת בין-עירונית|עוברים ליעד הבא|לינה חדשה|עצירות בדרך|עצירה בדרך|נסיעה ארוכה בין ערים/i;
const DEBUG_DAY_TRIP_PATTERN =
  /day trip|day-trip|excursion|half-day trip|round trip to|round-trip to|טיול יום|יום טיול|נסיעת יום|יציאה ליום|סיור יום/i;
const DEBUG_DAY_TRIP_BASE_RADIUS_KM = 5;
const DEBUG_DAY_TRIP_REAL_DISTANCE_MINUTES = 60;

export type TextualDayTypeDebug = "day_trip" | "transfer" | "normal";
export type DerivedDayTypeDebug = "arrival" | "departure" | "transfer" | "day_trip" | "normal";
/**
 * The full 4-value taxonomy only exists as an override (see
 * GeoResolutionOverrideMap below) — the degraded, unaided computation can
 * only ever produce provider/unresolved/n/a. "unmatched" is a THIRD,
 * distinct state from "unresolved": it means an override file DOES exist
 * for this trip's country but has no entry for this specific item (a
 * different generation run, an item added/edited after generation, or a
 * genuinely un-joinable key) — never conflate it with "unresolved" (a
 * real geoSource value meaning the resolver itself failed at generation
 * time). No override file at all produces neither value — it falls back
 * to the plain degraded computation instead.
 */
export type ItemGeoSourceDebug = "provider" | "recommendationId" | "fuzzyName" | "unresolved" | "unmatched" | "n/a";

export interface GeoResolutionOverrideEntry {
  geoSource: string;
  dayIndex: number;
  itemName: string;
  stayId: string | null;
}
export type GeoResolutionOverrideMap = Record<string, GeoResolutionOverrideEntry>;

/**
 * The join key between a generation-time geo-resolution.json fixture entry
 * (written by fixture-capture.ts's captureGeoResolutionFixture, under
 * CAPTURE_FIXTURES=1) and a persisted TripItineraryItem on the other side
 * of the save boundary. Neither side's own internal id works: a
 * generation-time item may have no stable id of its own, and a persisted
 * item's `id` is assigned fresh at save time, unrelated to anything from
 * generation. recommendationId DOES survive save unchanged and is
 * preferred; for an item with none — exactly the class of item a
 * fuzzyName resolution most often applies to, since an item WITH a
 * recommendationId would already resolve at the provider/recommendationId
 * tier — the fallback is day number + item name, the only other thing
 * both sides still agree on. Duplicated verbatim in
 * country-itinerary-generation.ts (not imported — lib/server/* is
 * off-limits to a client bundle); keep the two formulas identical or the
 * join silently stops matching.
 */
export function geoResolutionJoinKey(recommendationId: string | null, dayNumber: number, itemName: string): string {
  return recommendationId || `name:${dayNumber}:${itemName}`;
}

function isTextualIntercityTransferDayDebug(day: Pick<TripItineraryDay, "title" | "notes" | "transportation" | "transportSegments">): boolean {
  return DEBUG_TRANSFER_DAY_PATTERN.test(
    `${day.title} ${day.notes} ${day.transportation} ${(day.transportSegments ?? []).join(" ")}`
  );
}

function isStructuralRoundTripDayDebug(day: Pick<TripItineraryDay, "items">): boolean {
  const anchors = day.items
    .filter((item) => isRealPlaceItem(item) && item.lat != null && item.lon != null)
    .sort((a, b) => (a.plannedStartTime || "").localeCompare(b.plannedStartTime || ""));
  if (anchors.length < 3) return false;

  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const returnsToBase = haversineKm(first.lat, first.lon, last.lat, last.lon) <= DEBUG_DAY_TRIP_BASE_RADIUS_KM;
  if (!returnsToBase) return false;

  return anchors.slice(1, -1).some((middle) => {
    const oneWayMinutes = estimateTravelMinutes(first.lat, first.lon, middle.lat, middle.lon, "balanced", "");
    return oneWayMinutes > DEBUG_DAY_TRIP_REAL_DISTANCE_MINUTES;
  });
}

function isTextualDayTripDayDebug(day: Pick<TripItineraryDay, "title" | "notes" | "transportation" | "transportSegments" | "items">): boolean {
  if (isTextualIntercityTransferDayDebug(day)) return false;
  if (DEBUG_DAY_TRIP_PATTERN.test(`${day.title} ${day.notes} ${day.transportation}`)) return true;
  return isStructuralRoundTripDayDebug(day);
}

/** The "textual" half of the day-type comparison — verbatim mirror of the server's isDayTripDay/isIntercityTransferDay, never a planning decision. */
export function textualDayTypeDebug(
  day: Pick<TripItineraryDay, "title" | "notes" | "transportation" | "transportSegments" | "items">
): TextualDayTypeDebug {
  if (isTextualIntercityTransferDayDebug(day)) return "transfer";
  if (isTextualDayTripDayDebug(day)) return "day_trip";
  return "normal";
}

/**
 * The "derived" half — a JIT approximation of the server's deriveDayType,
 * built only from what a saved trip persists. See the module-level note
 * above for exactly how and why this can diverge from the real function.
 */
export function derivedDayTypeDebug(
  day: Pick<TripItineraryDay, "title" | "notes" | "transportation" | "transportSegments" | "items" | "cityCanonicalId">,
  previousDay: Pick<TripItineraryDay, "cityCanonicalId"> | null,
  isFirstDay: boolean,
  isLastDay: boolean
): DerivedDayTypeDebug {
  if (isFirstDay) return "arrival";
  if (isLastDay) return "departure";
  if (previousDay && day.cityCanonicalId && previousDay.cityCanonicalId && day.cityCanonicalId !== previousDay.cityCanonicalId) {
    return "transfer";
  }
  if (isStructuralRoundTripDayDebug(day)) return "day_trip";
  return "normal";
}

export interface ItemGeographyDebugRow {
  itemId: string;
  itemName: string;
  category: TripItineraryItem["category"];
  geoSource: ItemGeoSourceDebug;
  precision: "point" | "none";
  legMinutes: number | null;
}

export interface DayGeographyDebugRow {
  dayNumber: number;
  ownerStay: string;
  derivedDayType: DerivedDayTypeDebug;
  textualDayType: TextualDayTypeDebug;
  dayTypeMismatch: boolean;
  totalLegMinutes: number;
  maxLegMinutes: number;
  unresolvedItemCount: number;
  items: ItemGeographyDebugRow[];
}

/**
 * The render-time (day-screen/PDF) diagnostic row for one saved day.
 * `pace` defaults to "balanced" when the caller doesn't have the trip's
 * real preference on hand (kept optional so this stays trivially testable
 * without a full trip object).
 */
export function computeDayGeographyDebugRow(
  day: TripItineraryDay,
  previousDay: TripItineraryDay | null,
  isFirstDay: boolean,
  isLastDay: boolean,
  pace: "relaxed" | "balanced" | "fast" = "balanced",
  geoResolutionOverride: GeoResolutionOverrideMap | null = null
): DayGeographyDebugRow {
  const anchorLat = day.accommodationLat;
  const anchorLon = day.accommodationLon;
  let totalLegMinutes = 0;
  let maxLegMinutes = 0;
  let unresolvedItemCount = 0;

  // A missing file (null) and an empty/non-matching file are two
  // different findings, not one — see ItemGeoSourceDebug's own note.
  const hasOverrideFile = geoResolutionOverride != null;

  const items: ItemGeographyDebugRow[] = day.items.map((item) => {
    const applicable = isRealPlaceItem(item);
    const override = geoResolutionOverride?.[geoResolutionJoinKey(item.recommendationId, day.dayNumber, item.name)];
    const geoSource: ItemGeoSourceDebug = !applicable
      ? "n/a"
      : override
        ? (override.geoSource as ItemGeoSourceDebug)
        : hasOverrideFile
          ? "unmatched"
          : item.lat != null && item.lon != null
            ? "provider"
            : "unresolved";
    const precision: "point" | "none" = item.lat != null && item.lon != null ? "point" : "none";
    if (applicable && geoSource === "unresolved") unresolvedItemCount += 1;
    const legMinutes =
      applicable && anchorLat != null && anchorLon != null && item.lat != null && item.lon != null
        ? estimateTravelMinutes(anchorLat, anchorLon, item.lat, item.lon, pace, "")
        : null;
    if (legMinutes != null) {
      totalLegMinutes += legMinutes;
      maxLegMinutes = Math.max(maxLegMinutes, legMinutes);
    }
    return {
      itemId: item.recommendationId || item.id,
      itemName: item.name,
      category: item.category,
      geoSource,
      precision,
      legMinutes,
    };
  });

  const derived = derivedDayTypeDebug(day, previousDay, isFirstDay, isLastDay);
  const textual = textualDayTypeDebug(day);

  return {
    dayNumber: day.dayNumber,
    ownerStay: day.cityRegion,
    derivedDayType: derived,
    textualDayType: textual,
    dayTypeMismatch: derived !== textual && derived !== "arrival" && derived !== "departure",
    totalLegMinutes: Math.round(totalLegMinutes),
    maxLegMinutes: Math.round(maxLegMinutes),
    unresolvedItemCount,
    items,
  };
}

export function computeGeographyDebugRows(
  days: TripItineraryDay[],
  pace: "relaxed" | "balanced" | "fast" = "balanced",
  geoResolutionOverride: GeoResolutionOverrideMap | null = null
): DayGeographyDebugRow[] {
  return days.map((day, index) =>
    computeDayGeographyDebugRow(
      day,
      index > 0 ? days[index - 1] : null,
      index === 0,
      index === days.length - 1,
      pace,
      geoResolutionOverride
    )
  );
}

export interface GeoResolutionMatchSummary {
  matched: number;
  total: number;
}

/**
 * The one-line "geo-resolution: N/M items matched" summary shown once at
 * the top of the overlay (day screen and PDF), not per day — spec "אני
 * רואה את זה בשנייה במקום להסיק לאורך 44 ימים". `total` is every real
 * place item across the WHOLE trip (isRealPlaceItem), `matched` is how
 * many of them found a real entry in the override file, regardless of
 * what that entry's geoSource value says (a matched item can still be
 * "unresolved" — matched only means "the file has an opinion about this
 * item", not "that opinion is good news"). Returns null when there's no
 * override file at all — nothing to summarize, and the caller should show
 * nothing rather than a misleading "0/0".
 */
export function computeGeoResolutionMatchSummary(
  days: TripItineraryDay[],
  geoResolutionOverride: GeoResolutionOverrideMap | null
): GeoResolutionMatchSummary | null {
  if (geoResolutionOverride == null) return null;
  let matched = 0;
  let total = 0;
  for (const day of days) {
    for (const item of day.items) {
      if (!isRealPlaceItem(item)) continue;
      total += 1;
      if (geoResolutionOverride[geoResolutionJoinKey(item.recommendationId, day.dayNumber, item.name)]) matched += 1;
    }
  }
  return { matched, total };
}
