import { differenceInCalendarDays, parseISO } from "date-fns";

import { formatTripDateRange } from "@/lib/format";

export type TripPhase = "planning" | "booked" | "currently_traveling" | "completed";
export type ItineraryGenerationMode =
  | "balanced"
  | "cheapest"
  | "fastest"
  | "relaxed"
  | "intensive"
  | "family_friendly"
  | "walking_friendly"
  | "safer_route";

export type TripWorkspaceTab =
  | "overview"
  | "itinerary"
  | "map"
  | "recommendations"
  | "budget"
  | "country_summary"
  | "practical"
  | "currency";

export type RecommendationCategory =
  | "attraction"
  | "restaurant"
  | "cafe"
  | "museum"
  | "nature"
  | "shopping"
  | "nightlife"
  | "family"
  | "hidden_gem"
  | "day_trip"
  | "seasonal_event"
  | "hotel"
  | "transportation"
  | "practical";

export type ItemPriority = "must" | "preferred" | "optional";

export type DayPart = "morning" | "lunch" | "afternoon" | "dinner" | "evening" | "night";

export type ExpenseCategory =
  | "accommodation"
  | "food"
  | "attractions"
  | "local_transportation"
  | "flights"
  | "shopping"
  | "other";

export type BookingType =
  | "flight"
  | "accommodation"
  | "train"
  | "bus"
  | "ferry"
  | "car_rental"
  | "attraction"
  | "restaurant"
  | "event"
  | "tour"
  | "other";
export type BookingStatus = "not_required" | "not_booked" | "booking_needed" | "reserved" | "booked" | "cancelled";
export type PaymentStatus = "unpaid" | "partially_paid" | "paid" | "refunded";

/**
 * Simplified 3-state toggle for the flight input card only — deliberately
 * not the general BookingStatus/PaymentStatus pair used by TripBooking,
 * which stays reserved for the full Bookings tab.
 */
export type FlightBookingStatus = "not_booked" | "booked" | "paid";

/**
 * All datetimes are local wall-clock time at their own airport (never
 * normalized to a shared zone) — departure fields are local to
 * departureAirport's zone, arrival fields to arrivalAirport's zone. See
 * flight-planning.ts for the timezone-aware arithmetic this enables.
 */
/** One intermediate stop on a connecting flight (spec items 17-19) — airport + how long the layover is, in the connection airport's own local time. */
export interface TripFlightConnection {
  /** The connection's own country — e.g. "TH" for a Bangkok stop between Israel and Japan. */
  countryIso: string;
  /** The airport this segment lands at. */
  arrivalAirport: string;
  /** The airport the next segment departs from — usually the same as arrivalAirport; differs only when the traveler changes airports mid-connection (e.g. HND in, NRT out). */
  departureAirport: string;
  layoverMinutes: number;
}

export interface TripFlightLeg {
  departureAirport: string;
  arrivalAirport: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  airline: string;
  flightNumber: string;
  cost: number | null;
  bookingStatus: FlightBookingStatus;
  /**
   * True when the flight isn't booked yet — departureTime holds a
   * representative time for the chosen period of day (estimatedWindowStart
   * holds the period key: "morning"|"afternoon"|"evening"|"night"; see
   * trip-wizard's step-flights.tsx for the exact representative times).
   * estimatedWindowEnd is unused in this model, kept for JSONB compat.
   * The date always comes from the trip's own start/end date, never entered
   * here.
   */
  estimated: boolean;
  estimatedWindowStart: string;
  estimatedWindowEnd: string;
  /** Deterministic distance-based estimate (flight-planning.ts) — never asked of the AI. Null until both airports resolve. */
  estimatedFlightDurationMinutes: number | null;
  /** True once the user has edited arrivalDate/arrivalTime by hand — the auto-calculation must never overwrite it again until reverted. */
  arrivalManuallySet: boolean;
  /**
   * Empty = direct flight (the default — spec item 22). departureAirport/
   * arrivalAirport/arrivalDate/arrivalTime above always describe the FINAL
   * origin/destination and the FINAL calculated arrival regardless of how
   * many connections exist, so every other consumer of TripFlightLeg
   * (flight-planning.ts's window/budget logic, the AI prompt) needs zero
   * changes to stay correct — connections only add displayed detail.
   */
  connections: TripFlightConnection[];
  /** Sum of connections[].layoverMinutes + every segment's own duration — total door-to-door time, distinct from airborne-only time (spec item 38). */
  totalJourneyMinutes: number | null;
}

export interface TripFlights {
  outbound: TripFlightLeg | null;
  return: TripFlightLeg | null;
}

export function createEmptyFlightLeg(): TripFlightLeg {
  return {
    departureAirport: "",
    arrivalAirport: "",
    departureDate: "",
    departureTime: "",
    arrivalDate: "",
    arrivalTime: "",
    airline: "",
    flightNumber: "",
    cost: null,
    bookingStatus: "not_booked",
    estimated: false,
    estimatedWindowStart: "",
    estimatedWindowEnd: "",
    estimatedFlightDurationMinutes: null,
    arrivalManuallySet: false,
    connections: [],
    totalJourneyMinutes: null,
  };
}

export interface TripPreferences {
  startDate: string;
  endDate: string;
  /**
   * "YYYY-MM" — set only for historical trips whose exact dates aren't known
   * yet, so the trip can still sort/group correctly by year and month
   * instead of falling back to its createdAt timestamp. Empty string when
   * not applicable (exact dates already known, or a non-historical trip).
   */
  partialDate: string;
  travelers: number;
  budget: number | null;
  tripStyle: string;
  tripPace: "relaxed" | "balanced" | "fast";
  generationMode: ItineraryGenerationMode;
  interests: string;
  transportationPreferences: string;
  accommodationArea: string;
  /** Comma-joined hard restrictions (e.g. "צמחוני, כשר") — a real AI hard constraint, distinct from foodNotes/interests (spec item 15). */
  dietaryPreferences: string;
  /** Free-text food notes (spec item 17) — kept separate from dietaryPreferences so that field stays a clean, parseable restriction list. */
  foodNotes: string;
  accessibilityNeeds: string;
  preferredRegions: string;
  mustVisitPlaces: string;
  placesToAvoid: string;
  safetyConstraints: string;
  /**
   * Optional — most trips don't set this yet. Home country/origin timezone
   * are not stored here: Israel / Asia/Jerusalem is the fixed default for
   * every trip (see HOME_COUNTRY_ISO_A2/HOME_TIMEZONE in flight-planning.ts),
   * never inferred from the destination.
   */
  flights?: TripFlights;
}

/**
 * "candidate" = the price came from a real, pre-priced candidate
 * recommendation. "ai_estimate" = the LLM invented the item and its price
 * was deterministically converted from the destination's local currency —
 * see `resolveItemPriceFields` in country-itinerary-generation.ts.
 */
export type PriceSourceType = "candidate" | "ai_estimate";

export interface TripRecommendation {
  id: string;
  name: string;
  category: RecommendationCategory;
  location: string;
  shortDescription: string;
  estimatedDurationMinutes: number | null;
  approximatePrice: number | null;
  openingHours: string;
  recommendedTimeOfDay: DayPart | "any";
  reservationRequired: boolean;
  priceOriginalAmount?: number | null;
  priceOriginalCurrency?: string | null;
  priceConvertedAmount?: number | null;
  priceExchangeRate?: number | null;
  priceRateTimestamp?: string | null;
  convertedCurrency?: string | null;
  sourceType?: PriceSourceType | null;
  mapLink: string;
  imageUrl: string;
  imageQuery: string;
  lat: number | null;
  lon: number | null;
  source: "saved" | "manual" | "api" | "database" | "ai";
  // Populated only when a real source provides them (e.g. an OSM wikipedia
  // tag) — never guessed, so most recommendations will leave these null.
  wikipediaUrl: string | null;
  website: string | null;
  wheelchairAccessible: boolean | null;
  isFree: boolean | null;
}

export interface TripItineraryItem {
  id: string;
  recommendationId: string | null;
  name: string;
  category: RecommendationCategory;
  location: string;
  shortDescription: string;
  slot: DayPart;
  plannedStartTime: string;
  /** Real end-of-visit clock time, from itinerary-scheduler.ts — lets the UI show "09:30–11:00" instead of a bare start time (spec item 15). Optional — absent on itineraries generated before this existed. */
  endTime?: string;
  // Live Trip Mode delay/reorder response (Stage 4) — a temporary, in-day
  // rescheduling estimate distinct from BOTH `plannedStartTime` (the
  // original plan, never overwritten — spec: planned data must never be
  // destroyed) and `actualStartTime` (only set once the activity truly
  // happens). Null once the item completes/is skipped, or when nothing has
  // shifted it.
  liveScheduledStartTime: string | null;
  actualStartTime: string;
  actualEndTime: string;
  estimatedDurationMinutes: number | null;
  approximatePrice: number | null;
  /** See AiGeneratedItem.pricePerPerson — the per-person figure approximatePrice's group total was derived from, when known. */
  pricePerPerson: number | null;
  priceOriginalAmount: number | null;
  priceOriginalCurrency: string | null;
  priceConvertedAmount: number | null;
  priceExchangeRate: number | null;
  priceRateTimestamp: string | null;
  convertedCurrency: string | null;
  sourceType: PriceSourceType | null;
  actualCost: number | null;
  travelMinutes: number | null;
  transportation: string;
  actualTransportation: string;
  openingHours: string;
  /** See AiGeneratedItem.lastEntryTime. */
  lastEntryTime: string;
  reservationRequired: boolean;
  bookingCompleted: boolean;
  optional: boolean;
  locked: boolean;
  priority: ItemPriority;
  fixedTime: boolean;
  completed: boolean;
  completedAt: string | null;
  skipped: boolean;
  skippedAt: string | null;
  skipReason: string | null;
  plannedNotes: string;
  journalNotes: string;
  mapLink: string;
  lat: number | null;
  lon: number | null;
  alternativeSuggestion: string;
  bookingWarning: string;
  spontaneous: boolean;
  // Personal travel log — always user-entered, never inferred.
  personalRating: number | null;
  wouldVisitAgain: boolean | null;
  actualDurationMinutes: number | null;
  // Stage 5 — Planned vs Actual.
  favorite: boolean;
  // Set when the traveler ate/visited somewhere different than planned
  // (e.g. the planned restaurant was full) — `name`/`location` stay the
  // planned place untouched, this is the actual one.
  actualPlaceName: string;
  // Forward-compatible marker for a future "replaced" item-status distinct
  // from skipped; not yet set by any replacement flow (Stage 4's
  // applyDeterministicReplacement/mergeLiveReplanResult still fully remove
  // the old item rather than flagging it — see Stage 5 plan's scope note).
  replaced: boolean;
  /** See AiGeneratedItem.canonicalPlaceId. */
  canonicalPlaceId: string;
}

export interface TripItineraryDay {
  id: string;
  dayNumber: number;
  title: string;
  /** See AiGeneratedDay.theme. */
  theme: string;
  date: string;
  cityRegion: string;
  // Coordinate-based canonical identity for cityRegion (e.g. "ge:41.69:44.80"),
  // stamped post-generation by canonicalizeItineraryCities (city-normalization.ts)
  // so "Tbilisi"/"טביליסי" merge into one place instead of counting as two
  // cities. Optional — absent on itineraries generated before this existed.
  cityCanonicalId?: string;
  accommodation: string;
  accommodationMapLink: string;
  accommodationLat: number | null;
  accommodationLon: number | null;
  // Set at selection time (buildHotelSelectionPatch, spec §F2/§G) when the
  // chosen hotel is real-distance-incompatible with this stay's own
  // activity clusters — the selection itself is still honored (spec §F3:
  // "user selection is authoritative"), this only exposes the tradeoff.
  // Optional/absent for every day generated before this existed, and for
  // any day whose hotel was never explicitly selected at all.
  accommodationBaseMismatch?: { nearestClusterKm: number; thresholdKm: number } | null;
  // Section C/E/F — recomputed by stay-routing.ts's recalculateStayRouting
  // whenever a hotel is selected/changed, using the real hotel coordinates
  // as the stay's anchor (never the old area centroid). Inline shapes here
  // rather than importing from stay-routing.ts, which itself imports
  // haversineKm from this file — importing back would be circular.
  // Absent/undefined for a day whose stay has no adjacent stay in that
  // direction (first/last stay) or was never recalculated.
  inboundTransitionMinutes?: number | null;
  outboundTransitionMinutes?: number | null;
  arrivalTransferMinutes?: number | null;
  departureTransferMinutes?: number | null;
  hotelCausedTransitionConflict?: { direction: "inbound" | "outbound"; estimatedMinutes: number } | null;
  hotelCausedAirportConflict?: { direction: "arrival" | "departure"; estimatedGroundMinutes: number; assumedGroundMinutes: number } | null;
  notes: string;
  transportation: string;
  estimatedCost: number | null;
  activityCost: number | null;
  foodCost: number | null;
  transportCost: number | null;
  accommodationCost: number | null;
  totalTravelMinutes: number | null;
  warnings: string[];
  alternatives: string[];
  bookingRequirements: string[];
  safetyNotes: string[];
  restWindow: string;
  transportSegments: string[];
  items: TripItineraryItem[];
  // Day-end flow (Stage 4) — intentionally minimal, not the full post-trip
  // journal (that's a later stage).
  favoriteMoment: string;
  dayEndNote: string;
  dayCompletedAt: string | null;
  // Stage 5 — day rating + actual accommodation (if it differed from plan).
  dayRating: number | null;
  dayRatingCategories: Partial<Record<"activities" | "food" | "pace" | "weather", number>>;
  actualAccommodation: string;
}

export interface TripBooking {
  id: string;
  tripId: string;
  dayId: string | null;
  itineraryItemId: string | null;
  type: BookingType;
  title: string;
  provider: string;
  confirmationNumber: string;
  bookingReference: string;
  startDateTime: string;
  endDateTime: string;
  location: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  amountOriginal: number | null;
  amountOriginalCurrency: string | null;
  amountConverted: number | null;
  exchangeRate: number | null;
  rateTimestamp: string | null;
  documentIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type TripDocumentType =
  | "boarding_pass"
  | "flight_confirmation"
  | "hotel_confirmation"
  | "train_ticket"
  | "attraction_ticket"
  | "restaurant_reservation"
  | "insurance"
  | "passport"
  | "visa"
  | "car_rental_confirmation"
  | "other";

// Metadata only — the file itself lives in Supabase Storage (private bucket,
// accessed only via a server-minted signed URL). This record is safe to keep
// in the same workspace_snapshot JSONB blob as everything else.
export interface TripDocument {
  id: string;
  tripId: string;
  bookingId: string | null;
  itineraryItemId: string | null;
  type: TripDocumentType;
  title: string;
  fileName: string;
  mimeType: string;
  notes: string;
  isSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ChecklistCategory =
  | "documents"
  | "money"
  | "health"
  | "transport"
  | "accommodation"
  | "bookings"
  | "packing"
  | "connectivity"
  | "home"
  | "other";

export interface TripChecklistItem {
  id: string;
  tripId: string;
  title: string;
  category: ChecklistCategory;
  dueDate: string | null;
  completed: boolean;
  source: "auto" | "user";
  // Stable key for auto-generated items (e.g. "flight-passport") so
  // regeneration can update an existing item in place instead of duplicating
  // it — user items always have autoKey: null and are never touched by
  // regeneration.
  autoKey: string | null;
  linkedBookingId: string | null;
  linkedDocumentId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface TripExpense {
  id: string;
  category: ExpenseCategory;
  label: string;
  amount: number;
  // Additive currency context (Stage 4) — `amount` keeps its existing
  // meaning (the displayed/converted total) so the legacy budget UI in
  // country-trip-workspace.tsx keeps working unchanged; these are optional
  // extra fields, not a rename.
  amountOriginalCurrency: string | null;
  exchangeRate: number | null;
  rateTimestamp: string | null;
  date: string;
  dayId: string | null;
  itemId: string | null;
  notes: string;
}

export interface TripJournalEntry {
  id: string;
  dayId: string | null;
  date: string | null;
  time: string;
  city: string | null;
  place: string | null;
  title: string;
  text: string;
  mood: number | null;
  rating: number | null;
  photoIds: string[];
  // Stage 5 additions.
  tags: string[];
  activityId: string | null;
  favoriteMemory: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PackingCategory =
  | "documents"
  | "clothing"
  | "shoes"
  | "electronics"
  | "health"
  | "toiletries"
  | "weather"
  | "outdoor"
  | "beach"
  | "formal_nightlife"
  | "travel_accessories"
  | "medication"
  | "special_activities"
  | "other";

export interface PackingItem {
  id: string;
  category: PackingCategory;
  name: string;
  quantity: number;
  packed: boolean;
  required: boolean;
  source: "automatic" | "user";
  notes: string;
}

export const PACKING_CATEGORY_LABELS: Record<PackingCategory, string> = {
  documents: "מסמכים",
  clothing: "בגדים",
  shoes: "נעליים",
  electronics: "אלקטרוניקה",
  health: "בריאות",
  toiletries: "טואלטיקה",
  weather: "מזג אוויר",
  outdoor: "פעילות בחוץ",
  beach: "חוף",
  formal_nightlife: "אירועים/חיי לילה",
  travel_accessories: "אביזרי נסיעה",
  medication: "תרופות",
  special_activities: "פעילויות מיוחדות",
  other: "אחר",
};

export interface TripMemoryPhoto {
  id: string;
  imageUrl: string;
  caption: string;
  date: string;
  location: string;
  relatedItemId: string | null;
  favorite: boolean;
  cover: boolean;
}

export interface TripSummary {
  overallTripSummary: string;
  favoriteMemory: string;
  favoritePlace: string;
  favoriteRestaurant: string;
  bestDay: string;
  biggestSurprise: string;
  differentlyNextTime: string;
  personalRating: number | null;
  tripHighlights: string;
  lessonsLearned: string;
  recommendationsForOthers: string;
}

export type LiveTripEventType =
  | "activity_completed"
  | "activity_skipped"
  | "delay_reported"
  | "activity_replaced"
  | "route_changed"
  | "spontaneous_activity_added"
  | "day_completed";

// Meaningful live-trip actions only — never UI-only noise (tab switches,
// map pans, etc). Useful later for post-trip history/summary.
export interface LiveTripEvent {
  id: string;
  tripId: string;
  dayId: string | null;
  itemId: string | null;
  type: LiveTripEventType;
  timestamp: string;
  detail: string;
}

export interface CountryTripWorkspaceState {
  version: 2;
  tripStatus: TripPhase;
  preferences: TripPreferences;
  recommendations: TripRecommendation[];
  itineraryDays: TripItineraryDay[];
  bookings: TripBooking[];
  documents: TripDocument[];
  checklist: TripChecklistItem[];
  estimatedExpenses: TripExpense[];
  actualExpenses: TripExpense[];
  journalEntries: TripJournalEntry[];
  memories: TripMemoryPhoto[];
  liveEvents: LiveTripEvent[];
  packingList: PackingItem[];
  summary: TripSummary;
  lastAiPlanSummary: string;
  // Stage 6 — AI Trip Story, regenerated on demand only, never auto-invoked.
  tripStory: string;
  tripStoryGeneratedAt: string | null;
}

export interface TripStatistics {
  totalTripDays: number;
  placesVisited: number;
  restaurantsVisited: number;
  distanceStops: number;
  totalEstimatedExpenses: number;
  totalActualExpenses: number;
  averageDailyExpense: number;
  completedItineraryPercentage: number;
  numberOfPhotos: number;
  topCategoryVisited: string;
  plannedActivities: number;
  completedActivities: number;
  skippedActivities: number;
  spontaneousAdditions: number;
}

export interface TripComparison {
  plannedCost: number;
  actualCost: number;
  costDifference: number;
  plannedActivities: number;
  completedActivities: number;
  plannedRestaurants: number;
  visitedRestaurants: number;
  skippedActivities: number;
  spontaneousAdditions: number;
}

export interface AiItineraryRequest {
  countryId: string;
  countryName: string;
  isoA2: string;
  tripStatus: TripPhase;
  preferences: TripPreferences;
  selectedPlaces: TripRecommendation[];
  recommendations: TripRecommendation[];
  bookings: TripBooking[];
  existingDays: TripItineraryDay[];
  regenerationScope?:
    | "full"
    | "day"
    | "activity"
    | "optimize_route"
    | "recalculate_costs"
    | "live_replan"
    | "live_replace_item";
  targetDayId?: string | null;
  targetItemId?: string | null;
  // Live Trip Mode (Stage 4): a free-text traveler instruction ("אני עייף",
  // "המקום סגור") threaded into the prompt only for regenerationScope ===
  // "live_replan" — see buildPrompt's liveReplanGuidance block.
  liveInstruction?: string | null;
  // Stage 7 — a compact, capped summary of explicit + accepted-learned
  // preferences (buildPersonalizationSummary in preference-learning.ts),
  // explicitly secondary to the trip-specific preferences already stated
  // above it in the prompt. Optional and safe to omit on any failure —
  // generation must never depend on personalization succeeding.
  personalizationSummary?: string | null;
  // A fresh client-generated id per generation attempt (not per retry of the
  // same attempt) — checked server-side so a duplicate POST (double-click,
  // network retry, or a race) returns the original result instead of
  // generating a second trip. See findCountryItineraryByClientRequestId.
  clientRequestId?: string;
  // Optional user-entered trip name from the creation wizard's first step —
  // wins over the AI-generated title when present.
  userProvidedTitle?: string;
  // Section B/H: the REAL Overpass provider outcome, aggregated by the
  // caller from its own actual per-category recommendation requests (each
  // request's real succeeded flag — never candidate count) — used verbatim
  // for GeneratedCountryItineraryPlan.candidateProviderStatus.overpass.
  // "partial" when some categories' real requests succeeded and others
  // didn't. null/undefined means the caller doesn't know (e.g. a test),
  // in which case a disclosed-imprecise candidate-count heuristic is the
  // fallback.
  overpassAvailable?: "available" | "unavailable" | "partial" | null;
}

export interface AiGeneratedItem {
  name: string;
  category: RecommendationCategory;
  location: string;
  shortDescription: string;
  slot: DayPart;
  plannedStartTime: string;
  /** Real end-of-visit clock time, assigned by itinerary-scheduler.ts. Optional — absent on plans generated before the scheduler existed, or wherever an item is built without going through it. */
  endTime?: string;
  estimatedDurationMinutes: number | null;
  approximatePrice: number | null;
  /**
   * The realistic price for ONE traveler, in the converted/target currency
   * — `approximatePrice` stays the whole-group total everywhere downstream
   * (unchanged), this is the per-person figure the total was derived from
   * (spec: "totalActivityCost = pricePerPerson × travelers"). Null when the
   * item's price came from a matched TripRecommendation candidate whose own
   * per-person/total semantics aren't audited yet (see resolveItemPriceFields).
   */
  pricePerPerson: number | null;
  priceOriginalAmount: number | null;
  priceOriginalCurrency: string | null;
  priceConvertedAmount: number | null;
  priceExchangeRate: number | null;
  priceRateTimestamp: string | null;
  convertedCurrency: string | null;
  sourceType: PriceSourceType | null;
  travelMinutes: number | null;
  openingHours: string;
  /** Last time you can still enter, when known and distinct from the closing time (spec item 17) — empty string when unknown, never guessed from closingHours. */
  lastEntryTime: string;
  reservationRequired: boolean;
  transportation: string;
  mapLink: string;
  lat: number | null;
  lon: number | null;
  bookingWarning: string;
  alternativeSuggestion: string;
  recommendationId: string | null;
  locked: boolean;
  priority: ItemPriority;
  fixedTime: boolean;
  /**
   * A real place identity (spec item 76) — `id:${recommendationId}` when
   * known, else `coords:${lat}:${lon}` when the item has real coordinates,
   * else "" (never a name-only identity: two genuinely different places
   * can share a generic name, and this app already learned the hard way —
   * see buildItemKey's own docstring — that guessing identity from name
   * alone risks false-positive duplicate merges). Derived in
   * fillDerivedDayFields via resolveCanonicalPlaceId; every other
   * construction site defaults it to "" and lets that pass fill it in.
   */
  canonicalPlaceId: string;
}

export interface AiGeneratedDay {
  dayNumber: number;
  date: string;
  title: string;
  cityRegion: string;
  /** Content-derived, always computed regardless of the AI's own title (spec items 49/50) — see inferDayThemeLabel. */
  theme: string;
  accommodation: string;
  notes: string;
  transportation: string;
  estimatedCost: number | null;
  activityCost: number | null;
  foodCost: number | null;
  transportCost: number | null;
  accommodationCost: number | null;
  totalTravelMinutes: number | null;
  warnings: string[];
  alternatives: string[];
  bookingRequirements: string[];
  safetyNotes: string[];
  restWindow: string;
  transportSegments: string[];
  items: AiGeneratedItem[];
}

export interface AiItineraryResponse {
  summary: string;
  title: string;
  totalEstimatedCost: number | null;
  estimatedTransportCost: number | null;
  averageDailyCost: number | null;
  costPerTraveler: number | null;
  categoryBreakdown: Record<string, number>;
  days: AiGeneratedDay[];
}

export const ITINERARY_GENERATION_MODE_LABELS: Record<ItineraryGenerationMode, string> = {
  balanced: "מאוזן",
  cheapest: "הכי חסכוני",
  fastest: "הכי מהיר",
  relaxed: "רגוע",
  intensive: "אינטנסיבי",
  family_friendly: "ידידותי למשפחה",
  walking_friendly: "ידידותי להליכה",
  safer_route: "מסלול בטוח יותר",
};

export const TRIP_STATUS_LABELS: Record<TripPhase, string> = {
  planning: "בתכנון",
  booked: "הוזמן",
  currently_traveling: "מטיילים עכשיו",
  completed: "הושלם",
};

export const WORKSPACE_TAB_LABELS: Record<TripWorkspaceTab, string> = {
  overview: "סקירה",
  itinerary: "מסלול",
  map: "מפה",
  recommendations: "המלצות",
  budget: "תקציב",
  country_summary: "סיכום המדינה",
  practical: "מידע שימושי",
  currency: "המרת מטבע",
};

export const RECOMMENDATION_CATEGORY_LABELS: Record<RecommendationCategory, string> = {
  attraction: "אטרקציות",
  restaurant: "מסעדות",
  cafe: "בתי קפה",
  museum: "מוזיאונים",
  nature: "טבע",
  shopping: "קניות",
  nightlife: "חיי לילה",
  family: "פעילויות משפחתיות",
  hidden_gem: "פנינים נסתרות",
  day_trip: "טיולי יום",
  seasonal_event: "אירועים עונתיים",
  hotel: "מלונות",
  transportation: "תחבורה",
  practical: "סידורים",
};

export const ITEM_PRIORITY_LABELS: Record<ItemPriority, string> = {
  must: "חובה",
  preferred: "רוצה",
  optional: "אופציונלי",
};

export const DAY_PART_LABELS: Record<DayPart, string> = {
  morning: "בוקר",
  lunch: "צהריים",
  afternoon: "אחה\"צ",
  dinner: "ערב מוקדם",
  evening: "ערב",
  night: "לילה",
};

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  accommodation: "לינה",
  food: "אוכל",
  attractions: "אטרקציות",
  local_transportation: "תחבורה מקומית",
  flights: "טיסות",
  shopping: "קניות",
  other: "אחר",
};

export const BOOKING_TYPE_LABELS: Record<BookingType, string> = {
  flight: "טיסה",
  accommodation: "לינה",
  train: "רכבת",
  bus: "אוטובוס",
  ferry: "מעבורת",
  car_rental: "השכרת רכב",
  attraction: "אטרקציה",
  restaurant: "מסעדה",
  event: "אירוע",
  tour: "סיור",
  other: "אחר",
};

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  not_required: "לא נדרש",
  not_booked: "לא הוזמן",
  booking_needed: "דרושה הזמנה",
  reserved: "משוריין",
  booked: "הוזמן",
  cancelled: "בוטל",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "לא שולם",
  partially_paid: "שולם חלקית",
  paid: "שולם",
  refunded: "הוחזר",
};

export const TRIP_DOCUMENT_TYPE_LABELS: Record<TripDocumentType, string> = {
  boarding_pass: "כרטיס עלייה למטוס",
  flight_confirmation: "אישור טיסה",
  hotel_confirmation: "אישור מלון",
  train_ticket: "כרטיס רכבת",
  attraction_ticket: "כרטיס לאטרקציה",
  restaurant_reservation: "הזמנת מסעדה",
  insurance: "ביטוח נסיעות",
  passport: "דרכון",
  visa: "ויזה",
  car_rental_confirmation: "אישור השכרת רכב",
  other: "אחר",
};

export const CHECKLIST_CATEGORY_LABELS: Record<ChecklistCategory, string> = {
  documents: "מסמכים",
  money: "כסף",
  health: "בריאות",
  transport: "תחבורה",
  accommodation: "לינה",
  bookings: "הזמנות",
  packing: "אריזה",
  connectivity: "טלפון/אינטרנט",
  home: "בית",
  other: "אחר",
};

export const DEFAULT_TAB_ORDER: TripWorkspaceTab[] = [
  "overview",
  "itinerary",
  "map",
  "recommendations",
  "budget",
  "country_summary",
  "practical",
  "currency",
];

const PACE_ACTIVITY_LIMITS: Record<TripPreferences["tripPace"], number> = {
  relaxed: 3,
  balanced: 4,
  fast: 5,
};

function pad(number: number) {
  return String(number).padStart(2, "0");
}

export function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function getTabOrderForStatus(status: TripPhase): TripWorkspaceTab[] {
  if (status === "currently_traveling") {
    return [
      "overview",
      "itinerary",
      "map",
      "budget",
      "recommendations",
      "country_summary",
      "practical",
      "currency",
    ];
  }

  if (status === "completed") {
    return [
      "overview",
      "country_summary",
      "budget",
      "recommendations",
      "map",
      "itinerary",
      "practical",
      "currency",
    ];
  }

  return DEFAULT_TAB_ORDER;
}

export function getTripDayCount(startDate: string, endDate: string, fallbackDays = 3) {
  if (!startDate || !endDate) return fallbackDays;
  try {
    return Math.max(differenceInCalendarDays(parseISO(endDate), parseISO(startDate)) + 1, 1);
  } catch {
    return fallbackDays;
  }
}

export function dateForDayNumber(startDate: string, dayNumber: number) {
  if (!startDate) return "";
  try {
    const start = parseISO(startDate);
    const date = new Date(start);
    date.setDate(start.getDate() + dayNumber - 1);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  } catch {
    return "";
  }
}

export function createEmptyItineraryItem(slot: DayPart = "morning"): TripItineraryItem {
  return {
    id: createId("item"),
    recommendationId: null,
    name: "",
    category: "attraction",
    location: "",
    shortDescription: "",
    slot,
    plannedStartTime: "",
    liveScheduledStartTime: null,
    actualStartTime: "",
    actualEndTime: "",
    estimatedDurationMinutes: null,
    approximatePrice: null,
    pricePerPerson: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    actualCost: null,
    travelMinutes: null,
    transportation: "",
    actualTransportation: "",
    openingHours: "",
    lastEntryTime: "",
    canonicalPlaceId: "",
    reservationRequired: false,
    bookingCompleted: false,
    optional: false,
    locked: false,
    priority: "preferred",
    fixedTime: false,
    completed: false,
    completedAt: null,
    skipped: false,
    skippedAt: null,
    skipReason: null,
    plannedNotes: "",
    journalNotes: "",
    mapLink: "",
    lat: null,
    lon: null,
    alternativeSuggestion: "",
    bookingWarning: "",
    spontaneous: false,
    personalRating: null,
    wouldVisitAgain: null,
    actualDurationMinutes: null,
    favorite: false,
    actualPlaceName: "",
    replaced: false,
  };
}

// Shared completed/skipped mutual-exclusion helpers (Stage 4) — the one
// place this dialog already handled it inline did so ad hoc; this is the
// single source of truth new Live Mode code should use instead of
// duplicating the toggle logic again.
export function markItemCompleted(
  item: TripItineraryItem,
  patch?: Partial<Pick<TripItineraryItem, "actualCost" | "actualStartTime" | "actualEndTime" | "journalNotes" | "personalRating">>
): TripItineraryItem {
  return {
    ...item,
    ...patch,
    completed: true,
    completedAt: new Date().toISOString(),
    skipped: false,
    skippedAt: null,
    skipReason: null,
    liveScheduledStartTime: null,
  };
}

export function markItemSkipped(item: TripItineraryItem, reason: string | null = null): TripItineraryItem {
  return {
    ...item,
    skipped: true,
    skippedAt: new Date().toISOString(),
    skipReason: reason,
    completed: false,
    completedAt: null,
    liveScheduledStartTime: null,
  };
}

export function recommendationToItineraryItem(recommendation: TripRecommendation, slot: DayPart): TripItineraryItem {
  return {
    ...createEmptyItineraryItem(slot),
    recommendationId: recommendation.id,
    name: recommendation.name,
    category: recommendation.category,
    location: recommendation.location,
    shortDescription: recommendation.shortDescription,
    estimatedDurationMinutes: recommendation.estimatedDurationMinutes,
    approximatePrice: recommendation.approximatePrice,
    priceOriginalAmount: recommendation.priceOriginalAmount ?? recommendation.approximatePrice,
    priceOriginalCurrency: recommendation.priceOriginalCurrency ?? null,
    priceConvertedAmount: recommendation.priceConvertedAmount ?? recommendation.approximatePrice,
    priceExchangeRate: recommendation.priceExchangeRate ?? null,
    priceRateTimestamp: recommendation.priceRateTimestamp ?? null,
    openingHours: recommendation.openingHours,
    reservationRequired: recommendation.reservationRequired,
    mapLink: recommendation.mapLink,
    lat: recommendation.lat,
    lon: recommendation.lon,
    canonicalPlaceId: deriveCanonicalPlaceId(recommendation.id, recommendation.lat, recommendation.lon),
  };
}

export function createEmptyDay(dayNumber: number, date = ""): TripItineraryDay {
  return {
    id: createId("day"),
    dayNumber,
    title: `Day ${dayNumber}`,
    theme: "",
    date,
    cityRegion: "",
    accommodation: "",
    accommodationMapLink: "",
    accommodationLat: null,
    accommodationLon: null,
    notes: "",
    transportation: "",
    estimatedCost: null,
    activityCost: null,
    foodCost: null,
    transportCost: null,
    accommodationCost: null,
    totalTravelMinutes: null,
    warnings: [],
    alternatives: [],
    bookingRequirements: [],
    safetyNotes: [],
    restWindow: "",
    transportSegments: [],
    items: [],
    favoriteMoment: "",
    dayEndNote: "",
    dayCompletedAt: null,
    dayRating: null,
    dayRatingCategories: {},
    actualAccommodation: "",
  };
}

export function createDefaultWorkspace(countryName: string): CountryTripWorkspaceState {
  return {
    version: 2,
    tripStatus: "planning",
    preferences: {
      startDate: "",
      endDate: "",
      partialDate: "",
      travelers: 2,
      budget: null,
      tripStyle: "חוויות מגוונות",
      tripPace: "balanced",
      generationMode: "balanced",
      interests: "",
      transportationPreferences: "",
      accommodationArea: "",
      dietaryPreferences: "",
      foodNotes: "",
      accessibilityNeeds: "",
      preferredRegions: "",
      mustVisitPlaces: "",
      placesToAvoid: "",
      safetyConstraints: "",
    },
    recommendations: [],
    itineraryDays: [createEmptyDay(1), createEmptyDay(2), createEmptyDay(3)],
    bookings: [],
    documents: [],
    checklist: [],
    estimatedExpenses: [],
    actualExpenses: [],
    journalEntries: [],
    memories: [],
    liveEvents: [],
    packingList: [],
    tripStory: "",
    tripStoryGeneratedAt: null,
    summary: {
      overallTripSummary: `טיול ב${countryName}`,
      favoriteMemory: "",
      favoritePlace: "",
      favoriteRestaurant: "",
      bestDay: "",
      biggestSurprise: "",
      differentlyNextTime: "",
      personalRating: null,
      tripHighlights: "",
      lessonsLearned: "",
      recommendationsForOthers: "",
    },
    lastAiPlanSummary: "",
  };
}

export function normalizeWorkspace(
  workspace: CountryTripWorkspaceState,
  countryName: string
): CountryTripWorkspaceState {
  const base = createDefaultWorkspace(countryName);
  const days =
    workspace.itineraryDays && workspace.itineraryDays.length > 0
      ? workspace.itineraryDays.map((day, index) => ({
          ...createEmptyDay(index + 1, day.date ?? ""),
          ...day,
          dayNumber: index + 1,
          title: day.title || `Day ${index + 1}`,
          items: (day.items ?? []).map((item) => ({
            ...createEmptyItineraryItem(item.slot ?? "morning"),
            ...item,
          })),
        }))
      : base.itineraryDays;

  // Defensive defaulting for bookings — the shape changed in Stage 3
  // (name/date/time/reference/status -> title/startDateTime/.../richer
  // status enum). Any pre-existing booking JSON just gets the new fields
  // backfilled rather than dropped, matching how items/days are normalized.
  const now = new Date().toISOString();
  const bookings = (workspace.bookings ?? []).map((booking) => ({
    id: booking.id ?? createId("booking"),
    tripId: booking.tripId ?? "",
    dayId: booking.dayId ?? null,
    itineraryItemId: booking.itineraryItemId ?? null,
    type: booking.type ?? "other",
    title: booking.title ?? "",
    provider: booking.provider ?? "",
    confirmationNumber: booking.confirmationNumber ?? "",
    bookingReference: booking.bookingReference ?? "",
    startDateTime: booking.startDateTime ?? "",
    endDateTime: booking.endDateTime ?? "",
    location: booking.location ?? "",
    status: booking.status ?? "not_booked",
    paymentStatus: booking.paymentStatus ?? "unpaid",
    amountOriginal: booking.amountOriginal ?? null,
    amountOriginalCurrency: booking.amountOriginalCurrency ?? null,
    amountConverted: booking.amountConverted ?? null,
    exchangeRate: booking.exchangeRate ?? null,
    rateTimestamp: booking.rateTimestamp ?? null,
    documentIds: booking.documentIds ?? [],
    notes: booking.notes ?? "",
    createdAt: booking.createdAt ?? now,
    updatedAt: booking.updatedAt ?? now,
  }));

  return {
    ...base,
    ...workspace,
    preferences: { ...base.preferences, ...workspace.preferences },
    summary: { ...base.summary, ...workspace.summary },
    itineraryDays: days,
    bookings,
    documents: workspace.documents ?? [],
    checklist: workspace.checklist ?? [],
    liveEvents: workspace.liveEvents ?? [],
    packingList: workspace.packingList ?? [],
    // Drop legacy one-per-day placeholder entries from before the trip-scoped
    // journal model (they never carried real content — no createdAt, no
    // title/text — so surfacing them would just be blank noise).
    journalEntries: (workspace.journalEntries ?? [])
      .filter((entry) => typeof entry.createdAt === "string" && entry.createdAt.length > 0)
      .map((entry) => ({
        ...entry,
        time: entry.time ?? "",
        tags: entry.tags ?? [],
        activityId: entry.activityId ?? null,
        favoriteMemory: entry.favoriteMemory ?? false,
      })),
  };
}

export interface ItineraryPlacement {
  day: TripItineraryDay;
  dayIndex: number;
  item: TripItineraryItem;
  itemIndex: number;
}

// Finds where a recommendation already lives in the itinerary, if anywhere.
// Matches by recommendationId first; falls back to name+coordinates since
// API-sourced recommendation ids aren't guaranteed stable across requests.
export function findItineraryPlacement(
  workspace: CountryTripWorkspaceState,
  recommendation: Pick<TripRecommendation, "id" | "name" | "lat" | "lon">
): ItineraryPlacement | null {
  for (let dayIndex = 0; dayIndex < workspace.itineraryDays.length; dayIndex += 1) {
    const day = workspace.itineraryDays[dayIndex];
    const itemIndex = day.items.findIndex(
      (item) =>
        item.recommendationId === recommendation.id ||
        (item.name === recommendation.name && item.lat === recommendation.lat && item.lon === recommendation.lon)
    );
    if (itemIndex !== -1) {
      return { day, dayIndex, item: day.items[itemIndex], itemIndex };
    }
  }
  return null;
}

export function buildMapLink(name: string, lat: number | null, lon: number | null) {
  if (lat != null && lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }
  return name ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}` : "";
}

// A directions/navigate link (destination-only, uses the device's current
// location as the implicit origin) — distinct from buildMapLink above,
// which only opens a search/pin. Promoted from the same pattern already
// duplicated once in attraction-modal/index.tsx.
export function buildDirectionsLink(lat: number | null, lon: number | null, name: string) {
  if (lat != null && lon != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  }
  return name ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(name)}` : "";
}

/**
 * A real, storable place identity (spec item 76) — see the identical
 * reasoning duplicated in country-itinerary-generation.ts's
 * resolveCanonicalPlaceId (kept separate rather than imported: that file
 * is server-only, this one is shared with the client). `id:${id}` when
 * known, else `coords:${lat}:${lon}` when real coordinates exist, else ""
 * — never a name-only identity (two genuinely different places can share
 * a generic name).
 */
export function deriveCanonicalPlaceId(id: string | null, lat: number | null, lon: number | null): string {
  if (id) return `id:${id}`;
  if (lat != null && lon != null) return `coords:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  return "";
}

export function haversineKm(
  lat1: number | null,
  lon1: number | null,
  lat2: number | null,
  lon2: number | null
) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const FUZZY_DUPLICATE_MAX_KM = 0.15; // ~150m

// Strips parenthetical suffixes ("Mtatsminda Park (Funicular)" ->
// "mtatsminda park") and punctuation so differently-worded mentions of the
// same real place collapse to the same slug — an exact name/coordinate
// match alone misses this class of duplicate (spec item 52/56's "duplicate
// Mtatsminda Park" symptom). Lives here (not itinerary-generation-
// constraints.ts, which imports FROM this file) so both the Gemini-repair
// pipeline's duplicate diagnostic AND the fallback template's own
// candidate selection use exactly one fuzzy-identity definition.
export function normalizePlaceNameSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FuzzyPlaceRecord {
  nameSlug: string;
  lat: number | null;
  lon: number | null;
}

export function isFuzzyDuplicatePlace(a: FuzzyPlaceRecord, b: FuzzyPlaceRecord): boolean {
  if (!a.nameSlug || !b.nameSlug) return false;
  const namesMatch = a.nameSlug === b.nameSlug || a.nameSlug.startsWith(b.nameSlug) || b.nameSlug.startsWith(a.nameSlug);
  if (!namesMatch) return false;
  // Both slugs matched (one contains the other) — if we also have
  // coordinates for both, only call it a duplicate when they're genuinely
  // close together, so "Mtatsminda Park" in Tbilisi never collides with an
  // unrelated same-named place elsewhere. Without coordinates for either
  // side, the strict slug match alone is treated as sufficient.
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return true;
  return haversineKm(a.lat, a.lon, b.lat, b.lon) <= FUZZY_DUPLICATE_MAX_KM;
}

// A hotel more than this from EVERY one of the stay's own activity
// clusters isn't "a bit further out" — it's a different area than the trip
// actually plans to spend the stay in (spec §D3/§F). Deliberately generous
// (hotels.ts's findHotelCandidates already scopes the search radius to
// 2.5km around one cluster point, so a real candidate is normally well
// under this) — meant to catch a hotel picked or kept from a completely
// different part of the trip, not to penalize a normal multi-cluster stay.
export const HOTEL_BASE_MISMATCH_KM = 15;

export interface HotelBaseMismatch {
  nearestClusterKm: number;
  thresholdKm: number;
}

/**
 * Detects a hotel (selected, recommended, or already booked) that is
 * geographically incompatible with the stay's own activity clusters (spec
 * §D3) — coordinates and real distance only, no city-name matching. Null
 * when the hotel is close enough to at least one cluster, or when there's
 * nothing real to compare against. Lives here (not hotels.ts) so the
 * client-safe hotel-selection flow (hotel-ui-helpers.ts) can call it
 * without pulling in hotels.ts's server-only Overpass dependency.
 */
export function detectHotelBaseMismatch(
  hotel: { lat: number | null; lon: number | null },
  activityClusters: Array<{ lat: number; lon: number }>,
  thresholdKm: number = HOTEL_BASE_MISMATCH_KM
): HotelBaseMismatch | null {
  if (hotel.lat == null || hotel.lon == null || activityClusters.length === 0) return null;

  const nearestClusterKm = Math.min(
    ...activityClusters.map((cluster) => haversineKm(hotel.lat, hotel.lon, cluster.lat, cluster.lon))
  );
  if (nearestClusterKm <= thresholdKm) return null;

  return { nearestClusterKm: Math.round(nearestClusterKm * 10) / 10, thresholdKm };
}

export function estimateTravelMinutes(
  fromLat: number | null,
  fromLon: number | null,
  toLat: number | null,
  toLon: number | null,
  pace: TripPreferences["tripPace"],
  transportation: string
) {
  const km = haversineKm(fromLat, fromLon, toLat, toLon);
  const speed =
    transportation.includes("הליכה") ? 4 : transportation.includes("רכב") ? 35 : 22;
  const buffer = pace === "relaxed" ? 1.25 : pace === "fast" ? 0.9 : 1;
  return km > 0 ? Math.round((km / speed) * 60 * buffer) : 0;
}

/**
 * Same distance basis as analyzeDayGeography's own cross-city detection
 * (itinerary-generation-constraints.ts's DISTANT_CITY_DISTANCE_KM) —
 * deliberately kept as one shared number rather than a second, possibly
 * inconsistent threshold, so "is this candidate too far away" and "is
 * this a cross-city day" never disagree with each other. Raw distance,
 * not travel time, for the same reason the existing validator uses it:
 * simple, mode-independent, and already proven not to misfire on real
 * trips.
 */
export const CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM = 80;

/**
 * Generic worldwide architecture (Phase 5/14): a HARD geographic gate, not
 * just a scoring signal. Real bug found in real-world QA: a day labeled
 * for one city could end up containing activities from an entirely
 * different city/region, because every candidate-selection/replacement
 * function (pickReplacementRecommendation, selectFallbackCandidate,
 * diversifyActivities, ensureMustVisitCoverage, ...) only ever scored
 * geographic proximity as one signal among several (category fit, budget
 * fit, "any" time-of-day, area-label text match) — a globally
 * well-matching candidate from a genuinely different city could still win
 * purely on those other factors, since nothing ever hard-rejected it for
 * simply being too far away. Pure coordinates, no per-city/per-country
 * special-casing — works identically for any destination.
 *
 * A day with no coordinate-bearing items yet (nothing established to
 * compare against) or a candidate with no coordinates of its own can't be
 * judged either way — this never blocks generation on missing geographic
 * data, it only rejects a candidate that IS demonstrably far from
 * everything already anchoring the day. A deliberate day-trip day is the
 * one explicit exemption (isDayTripDay), since being far from the day's
 * own base is the entire point of a day trip.
 */
export function isCandidateGeographicallyCompatibleWithDay(
  candidate: { lat: number | null; lon: number | null },
  existingAnchors: Array<{ lat: number | null; lon: number | null }>,
  args: { maxDistanceKm?: number; isDayTripDay?: boolean }
): boolean {
  if (args.isDayTripDay) return true;
  if (candidate.lat == null || candidate.lon == null) return true;

  const anchorsWithCoordinates = existingAnchors.filter((anchor) => anchor.lat != null && anchor.lon != null);
  if (anchorsWithCoordinates.length === 0) return true;

  const maxDistanceKm = args.maxDistanceKm ?? CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM;
  return anchorsWithCoordinates.some(
    (anchor) => haversineKm(anchor.lat, anchor.lon, candidate.lat, candidate.lon) < maxDistanceKm
  );
}

export type DayOptimizeMode = "fewer_transfers" | "less_walking";

const OPTIMIZE_CLUSTER_RADIUS_KM = 1.2;

function nearestNeighborOrder<T extends { lat: number | null; lon: number | null }>(
  pool: T[],
  start: { lat: number | null; lon: number | null }
): T[] {
  const remaining = [...pool];
  const ordered: T[] = [];
  let current = start;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((item, index) => {
      const distance = haversineKm(current.lat, current.lon, item.lat, item.lon);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = { lat: next.lat, lon: next.lon };
  }
  return ordered;
}

/**
 * Deterministic (non-AI) day reorder — locked and fixedTime items are never
 * moved from their current position; only the remaining items are
 * resequenced. "less_walking" runs a greedy nearest-neighbor pass over every
 * movable item. "fewer_transfers" first groups items into geographic
 * clusters (anything within ~1.2km of another item in the group) so the
 * route doesn't zig-zag between distant areas, then nearest-neighbors within
 * and across those clusters.
 */
export function optimizeDayItemOrder(
  items: TripItineraryItem[],
  mode: DayOptimizeMode
): TripItineraryItem[] {
  const anchoredIndices = new Set<number>();
  items.forEach((item, index) => {
    if (item.locked || item.fixedTime) anchoredIndices.add(index);
  });

  const movablePool = items.filter((item) => !item.locked && !item.fixedTime);
  if (movablePool.length <= 1) return items;

  const startCoords = { lat: movablePool[0].lat, lon: movablePool[0].lon };

  let orderedMovable: TripItineraryItem[];
  if (mode === "less_walking") {
    orderedMovable = nearestNeighborOrder(movablePool, startCoords);
  } else {
    const clusters: TripItineraryItem[][] = [];
    for (const item of movablePool) {
      const cluster = clusters.find((group) =>
        group.some((member) => haversineKm(member.lat, member.lon, item.lat, item.lon) <= OPTIMIZE_CLUSTER_RADIUS_KM)
      );
      if (cluster) cluster.push(item);
      else clusters.push([item]);
    }
    const orderedClusterReps = nearestNeighborOrder(
      clusters.map((group) => group[0]),
      startCoords
    );
    orderedMovable = orderedClusterReps.flatMap((representative) => {
      const group = clusters.find((cluster) => cluster.includes(representative));
      return group ? nearestNeighborOrder(group, startCoords) : [representative];
    });
  }

  const result = [...items];
  let cursor = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (anchoredIndices.has(index)) continue;
    result[index] = orderedMovable[cursor];
    cursor += 1;
  }
  return result;
}

export function buildTripStatistics(workspace: CountryTripWorkspaceState): TripStatistics {
  const plannedItems = workspace.itineraryDays.flatMap((day) => day.items);
  const completedItems = plannedItems.filter((item) => item.completed);
  const visitedByCategory = new Map<string, number>();
  for (const item of completedItems) {
    const label = RECOMMENDATION_CATEGORY_LABELS[item.category];
    visitedByCategory.set(label, (visitedByCategory.get(label) ?? 0) + 1);
  }

  let distanceStops = 0;
  for (const day of workspace.itineraryDays) {
    for (let index = 1; index < day.items.length; index += 1) {
      const previous = day.items[index - 1];
      const current = day.items[index];
      distanceStops += haversineKm(previous.lat, previous.lon, current.lat, current.lon);
    }
  }

  const totalActualExpenses = workspace.actualExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const totalEstimatedExpenses = workspace.estimatedExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const photoCount = workspace.memories.length;
  const topCategoryVisited = [...visitedByCategory.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "—";

  return {
    totalTripDays: workspace.itineraryDays.length,
    placesVisited: completedItems.length,
    restaurantsVisited: completedItems.filter((item) => item.category === "restaurant" || item.category === "cafe").length,
    distanceStops: Number(distanceStops.toFixed(1)),
    totalEstimatedExpenses,
    totalActualExpenses,
    averageDailyExpense: workspace.itineraryDays.length > 0 ? totalActualExpenses / workspace.itineraryDays.length : 0,
    completedItineraryPercentage:
      plannedItems.length > 0 ? Math.round((completedItems.length / plannedItems.length) * 100) : 0,
    numberOfPhotos: photoCount,
    topCategoryVisited,
    plannedActivities: plannedItems.length,
    completedActivities: completedItems.length,
    skippedActivities: plannedItems.filter((item) => item.skipped).length,
    spontaneousAdditions: plannedItems.filter((item) => item.spontaneous).length,
  };
}

export function buildTripComparison(workspace: CountryTripWorkspaceState): TripComparison {
  const plannedItems = workspace.itineraryDays.flatMap((day) => day.items);
  const plannedCost = workspace.estimatedExpenses.reduce((sum, item) => sum + item.amount, 0);
  const actualCost = workspace.actualExpenses.reduce((sum, item) => sum + item.amount, 0);

  return {
    plannedCost,
    actualCost,
    costDifference: actualCost - plannedCost,
    plannedActivities: plannedItems.length,
    completedActivities: plannedItems.filter((item) => item.completed).length,
    plannedRestaurants: plannedItems.filter((item) => item.category === "restaurant" || item.category === "cafe").length,
    visitedRestaurants: plannedItems.filter(
      (item) => (item.category === "restaurant" || item.category === "cafe") && item.completed
    ).length,
    skippedActivities: plannedItems.filter((item) => item.skipped).length,
    spontaneousAdditions: plannedItems.filter((item) => item.spontaneous).length,
  };
}

function categoryPriority(category: RecommendationCategory) {
  switch (category) {
    case "restaurant":
    case "cafe":
      return 6;
    case "nightlife":
      return 5;
    case "museum":
    case "nature":
    case "attraction":
    case "hidden_gem":
    case "day_trip":
      return 4;
    case "shopping":
    case "family":
    case "seasonal_event":
      return 3;
    case "hotel":
    case "transportation":
    case "practical":
      return 1;
    default:
      return 2;
  }
}

function sanitizeCandidates(candidates: TripRecommendation[]) {
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => candidate.name.trim())
    .filter((candidate) => {
      const key = `${candidate.name.toLowerCase()}::${candidate.location.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => categoryPriority(right.category) - categoryPriority(left.category));
}

function slotTime(slot: DayPart) {
  switch (slot) {
    case "morning":
      return "09:00";
    case "lunch":
      return "12:30";
    case "afternoon":
      return "15:00";
    case "dinner":
      return "19:00";
    case "evening":
      return "21:00";
    case "night":
      return "23:00";
  }
}

export function buildWarnings(items: AiGeneratedItem[], pace: TripPreferences["tripPace"]) {
  const warnings: string[] = [];
  const activeItems = items.filter((item) => item.name);
  const totalMinutes = activeItems.reduce(
    (sum, item) => sum + (item.estimatedDurationMinutes ?? 90) + (item.travelMinutes ?? 0),
    0
  );
  const crowdedThreshold = pace === "relaxed" ? 480 : pace === "balanced" ? 600 : 720;
  if (
    activeItems.some(
      (item) =>
        item.slot !== "lunch" &&
        item.slot !== "dinner" &&
        item.openingHours.toLowerCase().includes("סגור")
    )
  ) {
    warnings.push("יש פעילויות עם סיכון לקונפליקט בשעות הפתיחה. בדקו מול המקום לפני היציאה.");
  }
  if (activeItems.some((item) => (item.travelMinutes ?? 0) >= 90)) {
    warnings.push("יש מקטע מעבר ארוך במיוחד. כדאי לבדוק כרטיסים, עומסי דרך או חלופה קרובה יותר.");
  }
  if (totalMinutes > crowdedThreshold + 120) {
    warnings.push("היום עדיין כבד גם אחרי תיקוני המסלול, ולכן כדאי להשאיר גמישות בשעות הערב.");
  }
  return warnings;
}

type FallbackDayKind =
  | "exploration"
  | "culture"
  | "nature"
  | "food"
  | "shopping"
  | "nightlife"
  | "day_trip"
  | "transfer"
  | "rest"
  | "practical";

interface FallbackDayTemplate {
  kind: FallbackDayKind;
  titleHint: string;
  slots: DayPart[];
  maxStops: number;
  notes: string;
  restWindow: string;
}

const FALLBACK_FOOD_CATEGORIES = new Set<RecommendationCategory>(["restaurant", "cafe"]);

function fallbackAreaLabel(location: string) {
  return location
    .split(/[,|·/]/)
    .map((part) => part.trim())
    .find(Boolean) ?? location.trim();
}

function parsePreferenceKeywords(value: string) {
  return value
    .toLowerCase()
    .split(/[,;\n/|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function buildFallbackAreaRankings(pool: TripRecommendation[]) {
  const stats = new Map<string, { count: number; categories: Set<RecommendationCategory> }>();

  for (const recommendation of pool) {
    const area = fallbackAreaLabel(recommendation.location);
    if (!area) continue;

    const current = stats.get(area) ?? { count: 0, categories: new Set<RecommendationCategory>() };
    current.count += 1;
    current.categories.add(recommendation.category);
    stats.set(area, current);
  }

  return [...stats.entries()]
    .sort((left, right) => {
      const rightScore = right[1].count * 4 + right[1].categories.size * 3;
      const leftScore = left[1].count * 4 + left[1].categories.size * 3;
      return rightScore - leftScore;
    })
    .map(([area]) => area);
}

function hasAnyInterest(value: string, needles: string[]) {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function hasRecommendationCategory(pool: TripRecommendation[], categories: RecommendationCategory[]) {
  return pool.some((candidate) => categories.includes(candidate.category));
}

function buildFallbackDayTemplate(
  input: AiItineraryRequest,
  pool: TripRecommendation[],
  dayNumber: number,
  dayCount: number
): FallbackDayTemplate {
  const baseMaxStops = PACE_ACTIVITY_LIMITS[input.preferences.tripPace];
  const longTrip = dayCount > 7;
  const veryLongTrip = dayCount > 13;
  const interests = `${input.preferences.tripStyle} ${input.preferences.interests}`;
  const likesFood = hasAnyInterest(interests, ["אוכל", "food", "culinary", "market", "שוק", "גסטרו"]);
  const likesNature = hasAnyInterest(interests, ["טבע", "nature", "park", "hike", "hiking", "garden", "גנים"]);
  const likesNightlife = hasAnyInterest(interests, ["nightlife", "חיי לילה", "bars", "bar", "club", "karaoke", "concert"]);
  const hasFood = hasRecommendationCategory(pool, ["restaurant", "cafe"]);
  const hasMuseum = hasRecommendationCategory(pool, ["museum"]);
  const hasNature = hasRecommendationCategory(pool, ["nature"]);
  const hasShopping = hasRecommendationCategory(pool, ["shopping"]);
  const hasNightlife = hasRecommendationCategory(pool, ["nightlife"]);
  const hasDayTrip = hasRecommendationCategory(pool, ["day_trip"]);

  if (longTrip && dayNumber > 1 && dayNumber % 7 === 0) {
    return {
      kind: "rest",
      titleHint: "יום קל וגמיש",
      slots: ["morning", "lunch", "afternoon", "dinner"],
      maxStops: Math.max(3, baseMaxStops - 1),
      notes: "יום קל יותר עם בוקר רגוע, אוכל קרוב ושוליים לספונטניות או מנוחה.",
      restWindow: "השאירו חלון גמיש למנוחה, כביסה, תכנון או התאוששות לקראת הימים הבאים.",
    };
  }

  if (longTrip && dayNumber > 1 && (dayNumber - 1) % (veryLongTrip ? 6 : 5) === 0) {
    return {
      kind: "transfer",
      titleHint: "יום מעבר",
      slots: ["lunch", "afternoon", "dinner"],
      maxStops: Math.max(3, baseMaxStops),
      notes: "יום שמפנה מקום לצ'ק-אאוט, מעבר לבסיס הבא, צ'ק-אין ופעילות קלה בלבד.",
      restWindow: "שמרו מרווח לצ'ק-אין, הפקדת מזוודות והתאוששות אחרי המעבר.",
    };
  }

  if (hasDayTrip && (dayNumber % 5 === 0 || (dayCount <= 6 && dayNumber === dayCount))) {
    return {
      kind: "day_trip",
      titleHint: "טיול יום",
      slots: ["morning", "lunch", "afternoon", "dinner"],
      maxStops: Math.max(4, baseMaxStops),
      notes: "יום שיוצא מעט מהשגרה העירונית עם מוקד ברור, נסיעות סבירות וחזרה נוחה בערב.",
      restWindow: "",
    };
  }

  if (hasNature && (likesNature || dayNumber % 4 === 0)) {
    return {
      kind: "nature",
      titleHint: "טבע ונוף",
      slots: ["morning", "lunch", "afternoon", "dinner"],
      maxStops: Math.max(4, baseMaxStops),
      notes: "יום שמעדיף קצב פתוח יותר, שטחים ירוקים או נופים, עם עצירות אוכל באותו אזור.",
      restWindow: "",
    };
  }

  if (hasFood && (likesFood || dayNumber % 6 === 0)) {
    return {
      kind: "food",
      titleHint: "שכונות ואוכל",
      slots: ["morning", "lunch", "afternoon", "dinner", "evening"],
      maxStops: Math.max(4, baseMaxStops),
      notes: "יום שמחבר שוק, רחובות מעניינים, עצירות אוכל טובות וסיום ערב נעים בלי לקפוץ רחוק.",
      restWindow: "",
    };
  }

  if (hasNightlife && (likesNightlife || dayNumber % 3 === 0)) {
    return {
      kind: "nightlife",
      titleHint: "ערב וחיי לילה",
      slots: ["morning", "lunch", "afternoon", "dinner", "evening", "night"],
      maxStops: input.preferences.tripPace === "relaxed" ? baseMaxStops : baseMaxStops + 1,
      notes: "יום עם בוקר רגוע יותר, מרכז יום ברור וסיום ערב באזור שקל להישאר בו גם אחרי החושך.",
      restWindow: input.preferences.tripPace === "relaxed" ? "אפשר להתחיל את היום מאוחר יותר כדי להשאיר אנרגיה לערב." : "",
    };
  }

  if (hasShopping && dayNumber % 3 === 0) {
    return {
      kind: "shopping",
      titleHint: "קניות ושיטוט",
      slots: ["morning", "lunch", "afternoon", "dinner", "evening"],
      maxStops: Math.max(4, baseMaxStops),
      notes: "יום שממוקד ברחובות חיים, חנויות, שווקים ועצירות קלות באותו אזור.",
      restWindow: "",
    };
  }

  if (hasMuseum && dayNumber % 2 === 0) {
    return {
      kind: "culture",
      titleHint: "תרבות ושכונות",
      slots: ["morning", "lunch", "afternoon", "dinner"],
      maxStops: Math.max(4, baseMaxStops),
      notes: "יום שמחבר בין מוסדות תרבות, הליכה בין שכונות וארוחות קרובות בלי נסיעות מיותרות.",
      restWindow: "",
    };
  }

  if (longTrip && dayNumber % 5 === 0) {
    return {
      kind: "practical",
      titleHint: "סידורים וגמישות",
      slots: ["lunch", "afternoon", "dinner"],
      maxStops: Math.max(3, baseMaxStops - 1),
      notes: "יום שמשאיר מקום לקניית כרטיסים, כביסה, תכנון המשך ופעילות קלה באותו אזור.",
      restWindow: "זה יום טוב לטפל בסידורים, לתכנן את ההמשך ולהשאיר זמן ספונטני.",
    };
  }

  return {
    kind: "exploration",
    titleHint: "שכונות ואתרים",
    slots: ["morning", "lunch", "afternoon", "dinner", "evening"],
    maxStops: Math.max(4, baseMaxStops),
    notes: "יום שמחבר עוגן מרכזי, עצירה משנית, אוכל קרוב ואפשרות לערב קל אם נשארת אנרגיה.",
    restWindow: "",
  };
}

function getFallbackPreferredCategories(kind: FallbackDayKind, slot: DayPart): RecommendationCategory[] {
  if (slot === "lunch") return ["cafe", "restaurant", "shopping", "hidden_gem"];
  if (slot === "dinner") return ["restaurant", "cafe", "nightlife", "shopping"];

  switch (kind) {
    case "culture":
      return slot === "morning" ? ["museum", "attraction", "hidden_gem"] : ["attraction", "museum", "hidden_gem", "shopping"];
    case "nature":
      return ["nature", "day_trip", "attraction", "hidden_gem"];
    case "food":
      return slot === "morning"
        ? ["hidden_gem", "shopping", "attraction", "cafe"]
        : slot === "evening"
          ? ["nightlife", "shopping", "hidden_gem"]
          : ["shopping", "hidden_gem", "attraction", "museum"];
    case "shopping":
      return ["shopping", "hidden_gem", "attraction", "cafe"];
    case "nightlife":
      return slot === "morning"
        ? ["cafe", "hidden_gem", "nature"]
        : slot === "evening" || slot === "night"
          ? ["nightlife", "shopping", "hidden_gem"]
          : ["attraction", "shopping", "museum", "hidden_gem"];
    case "day_trip":
      return ["day_trip", "nature", "attraction", "museum"];
    case "transfer":
      return ["attraction", "cafe", "shopping", "hidden_gem"];
    case "rest":
      return slot === "morning"
        ? ["cafe", "nature", "hidden_gem"]
        : ["hidden_gem", "shopping", "museum", "nature"];
    case "practical":
      return ["shopping", "hidden_gem", "museum", "attraction"];
    case "exploration":
    default:
      return ["attraction", "hidden_gem", "museum", "nature", "shopping"];
  }
}

function resolveFallbackTransportation(
  previousItem: AiGeneratedItem | null,
  candidate: TripRecommendation,
  input: AiItineraryRequest
) {
  const preferred = input.preferences.transportationPreferences || "תחבורה מקומית";
  const km = haversineKm(previousItem?.lat ?? null, previousItem?.lon ?? null, candidate.lat, candidate.lon);

  if (km > 0 && km <= 1.5) return "הליכה";
  return preferred;
}

function estimateFallbackTravelMinutes(
  previousItem: AiGeneratedItem | null,
  candidate: TripRecommendation,
  input: AiItineraryRequest,
  template: FallbackDayTemplate,
  transportation: string
) {
  if (!previousItem) return 0;

  if (previousItem.category === "transportation" && (previousItem.lat == null || candidate.lat == null)) {
    return template.kind === "transfer" ? 60 : 20;
  }

  const estimated = estimateTravelMinutes(
    previousItem.lat,
    previousItem.lon,
    candidate.lat,
    candidate.lon,
    input.preferences.tripPace,
    transportation
  );
  if (estimated > 0) return estimated;

  const sameArea =
    fallbackAreaLabel(previousItem.location).toLowerCase() === fallbackAreaLabel(candidate.location).toLowerCase();
  if (sameArea) return 12;
  if (template.kind === "day_trip") return 45;
  if (template.kind === "transfer") return 35;
  return 20;
}

function buildFallbackItemDescription(
  candidate: TripRecommendation,
  slot: DayPart,
  template: FallbackDayTemplate,
  dayArea: string
) {
  if (candidate.shortDescription.trim()) return candidate.shortDescription;

  if (slot === "lunch" || slot === "dinner") {
    return `עצירת אוכל באזור ${dayArea || fallbackAreaLabel(candidate.location)} כדי לשמור על יום נוח גאוגרפית.`;
  }

  if (template.kind === "transfer") {
    return `עצירה קלה באזור ${dayArea || fallbackAreaLabel(candidate.location)} שמתאימה ליום מעבר בלי להעמיס יותר מדי.`;
  }

  if (template.kind === "rest") {
    return `נקודה רגועה באזור ${dayArea || fallbackAreaLabel(candidate.location)} שמתאימה ליום קל יותר.`;
  }

  if (template.kind === "day_trip") {
    return `מוקד מתאים ליום טיול שמחובר היטב לשאר המסלול.`;
  }

  return `עצירה טובה באזור ${dayArea || fallbackAreaLabel(candidate.location)} שמשתלבת בטבעיות עם שאר היום.`;
}

function scoreFallbackCandidate(
  candidate: TripRecommendation,
  slot: DayPart,
  template: FallbackDayTemplate,
  preferredArea: string,
  previousItem: AiGeneratedItem | null,
  usageCounts: Map<string, number>,
  selectedIds: Set<string>,
  preferredKeywords: string[],
  avoidKeywords: string[]
) {
  const preferredCategories = getFallbackPreferredCategories(template.kind, slot);
  const candidateArea = fallbackAreaLabel(candidate.location).toLowerCase();
  const lowerPreferredArea = preferredArea.toLowerCase();
  const haystack = `${candidate.name} ${candidate.location}`.toLowerCase();
  const usageCount = usageCounts.get(candidate.id) ?? 0;
  const categoryIndex = preferredCategories.indexOf(candidate.category);
  let score = 0;

  if (avoidKeywords.some((keyword) => haystack.includes(keyword))) {
    return -1000;
  }

  if (categoryIndex >= 0) {
    score += 95 - categoryIndex * 8;
  } else if (slot === "lunch" || slot === "dinner") {
    score -= 30;
  } else if (FALLBACK_FOOD_CATEGORIES.has(candidate.category)) {
    score -= 10;
  }

  if (candidate.recommendedTimeOfDay === slot) score += 14;
  if (candidate.recommendedTimeOfDay === "any") score += 5;

  if (lowerPreferredArea && candidateArea) {
    if (candidateArea === lowerPreferredArea) score += 24;
    else if (candidateArea.includes(lowerPreferredArea) || lowerPreferredArea.includes(candidateArea)) score += 14;
  }

  if (preferredKeywords.some((keyword) => haystack.includes(keyword))) score += 12;
  if (selectedIds.has(candidate.id) || candidate.source === "saved" || candidate.source === "manual") score += 12;

  // usageCount is always 0 here now — selectFallbackCandidate hard-excludes
  // any already-used real place before scoring ever runs (see its own
  // comment). usageCount itself is kept as a parameter (still passed
  // through, still computed) purely so a future soft-preference use isn't
  // blocked by a signature change; it contributes nothing to the score.
  void usageCount;

  if (previousItem) {
    const km = haversineKm(previousItem.lat, previousItem.lon, candidate.lat, candidate.lon);
    if (km > 0 && km <= 1.5) score += 24;
    else if (km > 0 && km <= 4) score += 14;
    else if (km > 0 && km <= 10) score += 5;
    else if (km > 18) score -= 10;

    if (previousItem.category === candidate.category && !FALLBACK_FOOD_CATEGORIES.has(candidate.category)) {
      score -= 5;
    }
  }

  if (template.kind === "rest" && (candidate.estimatedDurationMinutes ?? 90) > 180) score -= 12;
  if (template.kind === "nature" && candidate.category === "nature") score += 18;
  if (template.kind === "shopping" && candidate.category === "shopping") score += 18;
  if (template.kind === "culture" && (candidate.category === "museum" || candidate.category === "attraction")) {
    score += 16;
  }
  if (template.kind === "food" && (slot === "lunch" || slot === "dinner")) {
    score += candidate.category === "restaurant" || candidate.category === "cafe" ? 20 : -10;
  }
  if (template.kind === "nightlife" && (slot === "evening" || slot === "night") && candidate.category === "nightlife") {
    score += 24;
  }
  if ((template.kind === "transfer" || template.kind === "practical") && candidate.category === "transportation") {
    score += 12;
  }
  if (candidate.category === "hotel" && template.kind !== "transfer") score -= 12;

  return score;
}

export function selectFallbackCandidate(args: {
  pool: TripRecommendation[];
  slot: DayPart;
  template: FallbackDayTemplate;
  preferredArea: string;
  previousItem: AiGeneratedItem | null;
  existingItems: AiGeneratedItem[];
  usedToday: Set<string>;
  usageCounts: Map<string, number>;
  usedRealPlaces: FuzzyPlaceRecord[];
  selectedIds: Set<string>;
  preferredKeywords: string[];
  avoidKeywords: string[];
}) {
  // The day's FIRST pick has no existingItems to compare against yet —
  // isCandidateGeographicallyCompatibleWithDay correctly declines to judge
  // in that case (nothing established, don't block on missing data), which
  // used to leave the very first activity of a day with literally zero
  // geographic constraint (scoreFallbackCandidate's own km-based penalty
  // only ever applies once there's a previousItem). The pool's own
  // real-coordinate members that already share the day's assigned
  // preferredArea label give an area-appropriate reference to judge
  // against even before anything is actually placed yet.
  const preferredAreaAnchors =
    args.existingItems.length === 0 && args.preferredArea
      ? args.pool.filter(
          (candidate) => fallbackAreaLabel(candidate.location).toLowerCase() === args.preferredArea.toLowerCase()
        )
      : [];
  const geographicAnchors: Array<{ lat: number | null; lon: number | null }> = [
    ...args.existingItems,
    ...preferredAreaAnchors,
  ];

  const ranked = args.pool
    .filter((candidate) => !args.usedToday.has(candidate.id))
    // Real bug found in live production use (a real 10-day Israel trip
    // with a genuine, abundant Overpass candidate pool): usageCounts was
    // only ever a soft scoring penalty (-18 per prior use, below) — a
    // candidate that scored well on category/area/keyword match (routinely
    // +50-100+) could still outrank every never-used alternative once the
    // pool's best-fitting candidates for a slot were exhausted relative to
    // trip length, so the SAME real restaurant/attraction got picked again
    // on a later day. collectPlanDiagnostics correctly flagged this as a
    // real cross-day duplicate — but that flagged the FALLBACK template
    // itself, the last-resort path with no further repair step, so the
    // whole generation hard-failed with PLAN_NOT_FEASIBLE instead of
    // degrading to a placeholder. A real place already used anywhere in
    // the trip is now hard-excluded, the same "never reuse a specific
    // place, ever" rule the Gemini-repair pipeline's own
    // pickReplacementRecommendation/pickNearbyMealRecommendation already
    // enforce via usedPlaceKeys — ranked coming back empty here already
    // falls through to a real, honest placeholder (createFallbackMealPlaceholder/
    // createFallbackActivityPlaceholder), never a silent gap.
    .filter((candidate) => (args.usageCounts.get(candidate.id) ?? 0) === 0)
    // The SAME real place can appear under a different id (fetched
    // independently per category — see usedRealPlaces' own comment at its
    // declaration) — the id-only filter just above misses that. Uses the
    // exact fuzzy name+coordinate identity collectPlanDiagnostics itself
    // uses to flag a duplicate, so this can never disagree with it.
    .filter((candidate) => {
      const candidateRecord: FuzzyPlaceRecord = {
        nameSlug: normalizePlaceNameSlug(candidate.name),
        lat: candidate.lat,
        lon: candidate.lon,
      };
      return !args.usedRealPlaces.some((used) => isFuzzyDuplicatePlace(used, candidateRecord));
    })
    // Generic worldwide architecture (Phase 5/14): same hard geographic
    // gate as pickReplacementRecommendation — the fallback template's own
    // area preference (preferredArea) was only ever a soft scoring bonus
    // in scoreFallbackCandidate below, so a candidate that scored well on
    // category/time-of-day/budget could still win from a genuinely
    // different city. This is the deterministic template used whenever
    // real Gemini generation fails validation, so it runs disproportionately
    // often — real bug found in live QA: a "Tel Aviv" day containing
    // Haifa's Bahá'í Gardens, among other cross-city leaks.
    .filter((candidate) =>
      isCandidateGeographicallyCompatibleWithDay(candidate, geographicAnchors, {
        isDayTripDay: args.template.kind === "day_trip",
      })
    )
    .map((candidate) => ({
      candidate,
      score: scoreFallbackCandidate(
        candidate,
        args.slot,
        args.template,
        args.preferredArea,
        args.previousItem,
        args.usageCounts,
        args.selectedIds,
        args.preferredKeywords,
        args.avoidKeywords
      ),
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.candidate ?? null;
}

// Same reasoning as buildFreeExplorationReplacement's phrase rotation
// (country-itinerary-generation.ts) — a fixed name+area repeated across
// several days with no id/coordinates to distinguish them would otherwise
// read as a duplicate place to buildItemKey's fallback tier, failing the
// whole plan over harmless repeated filler content.
const FALLBACK_LUNCH_PHRASES = [
  (area: string) => `אזור אוכל מקומי ב${area}`,
  (area: string) => `שוק או פינת אוכל ב${area}`,
  (area: string) => `עצירת צהריים גמישה באזור ${area}`,
];
const FALLBACK_DINNER_PHRASES = [
  (area: string) => `ארוחת ערב באזור ${area}`,
  (area: string) => `מסעדה מקומית באזור ${area}`,
  (area: string) => `ארוחת ערב גמישה ליד ${area}`,
];

// Same phrase-rotation reasoning as FALLBACK_LUNCH_PHRASES/FALLBACK_DINNER_PHRASES
// just above — a fixed name+area repeated across days with no id/coordinates
// would otherwise read as a duplicate place to buildItemKey's fallback tier.
const FALLBACK_ACTIVITY_PHRASES: Partial<Record<DayPart, ((area: string) => string)[]>> = {
  morning: [
    (area) => `שיטוט וגילוי באזור ${area}`,
    (area) => `סיור רגלי בשכונות ${area}`,
    (area) => `תצפית ונקודות עניין באזור ${area}`,
  ],
  afternoon: [
    (area) => `המשך שיטוט ואתרים קרובים באזור ${area}`,
    (area) => `זמן לגילוי ספונטני באזור ${area}`,
    (area) => `שכונה מעניינת ליד ${area}`,
  ],
  evening: [
    (area) => `טיול ערב קליל באזור ${area}`,
    (area) => `שיטוט ערב וצפייה בחיים המקומיים ב${area}`,
    (area) => `זמן פנוי לבחירה אישית באזור ${area}`,
  ],
  night: [
    (area) => `המשך ערב באזור ${area}`,
    (area) => `שיטוט לילי קליל ב${area}`,
  ],
};

function createFallbackActivityPlaceholder(
  slot: DayPart,
  dayArea: string,
  input: AiItineraryRequest,
  dayNumber: number
): AiGeneratedItem {
  const phrases = FALLBACK_ACTIVITY_PHRASES[slot] ?? FALLBACK_ACTIVITY_PHRASES.afternoon!;
  const name = dayArea ? phrases[dayNumber % phrases.length](dayArea) : `שיטוט וגילוי ב${input.countryName}`;

  return {
    name,
    category: "attraction",
    location: dayArea || input.countryName,
    shortDescription:
      "אם אין המלצה ספציפית זמינה, שוטטו באזור הפעילויות של אותו יום — רחובות מרכזיים, נקודות תצפית או שכונות סמוכות שוות גילוי.",
    slot,
    plannedStartTime: slotTime(slot),
    estimatedDurationMinutes: slot === "evening" || slot === "night" ? 90 : 120,
    approximatePrice: null,
    pricePerPerson: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: 10,
    openingHours: "",
    lastEntryTime: "",
    canonicalPlaceId: "",
    reservationRequired: false,
    transportation: "הליכה",
    mapLink: buildMapLink(dayArea || input.countryName, null, null),
    lat: null,
    lon: null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
    locked: false,
    priority: "preferred",
    fixedTime: false,
  };
}

function createFallbackMealPlaceholder(
  slot: DayPart,
  dayArea: string,
  input: AiItineraryRequest,
  dayNumber: number
): AiGeneratedItem {
  const phrases = slot === "lunch" ? FALLBACK_LUNCH_PHRASES : FALLBACK_DINNER_PHRASES;
  const name = dayArea
    ? phrases[dayNumber % phrases.length](dayArea)
    : slot === "lunch"
      ? "שוק או אזור אוכל מקומי"
      : "אזור אוכל מומלץ לערב";

  return {
    name,
    category: slot === "lunch" ? "cafe" : "restaurant",
    location: dayArea || input.countryName,
    shortDescription:
      "אם אין מקום ספציפי זמין, חפשו מסעדות, דוכנים או קפה טובים ממש באזור הפעילויות של אותו יום.",
    slot,
    plannedStartTime: slotTime(slot),
    estimatedDurationMinutes: slot === "lunch" ? 60 : 75,
    approximatePrice: null,
    pricePerPerson: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: 10,
    openingHours: "לא זמין",
    lastEntryTime: "",
    canonicalPlaceId: "",
    reservationRequired: false,
    transportation: "הליכה",
    mapLink: buildMapLink(dayArea || input.countryName, null, null),
    lat: null,
    lon: null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
    locked: false,
    priority: "preferred",
    fixedTime: false,
  };
}

function createFallbackPracticalItem(
  template: FallbackDayTemplate,
  dayArea: string,
  input: AiItineraryRequest
): AiGeneratedItem | null {
  if (template.kind === "transfer") {
    return {
      name: "צ'ק-אאוט, שמירת מזוודות ומעבר לבסיס הבא",
      category: "practical",
      location: dayArea || input.countryName,
      shortDescription: "בלוק פרקטי ליציאה מהלינה, נסיעה מסודרת וצ'ק-אין לפני שמעמיסים עוד פעילויות.",
      slot: "morning",
      plannedStartTime: "08:30",
      estimatedDurationMinutes: 90,
      approximatePrice: null,
      pricePerPerson: null,
      priceOriginalAmount: null,
      priceOriginalCurrency: null,
      priceConvertedAmount: null,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: null,
      travelMinutes: 0,
      openingHours: "לא זמין",
      lastEntryTime: "",
      canonicalPlaceId: "",
      reservationRequired: false,
      transportation: input.preferences.transportationPreferences || "תחבורה מקומית",
      mapLink: buildMapLink(dayArea || input.countryName, null, null),
      lat: null,
      lon: null,
      bookingWarning: "בדקו שעות צ'ק-אאוט, אחסון מזוודות והגעה ללינה החדשה.",
      alternativeSuggestion: "",
      recommendationId: null,
      locked: false,
      priority: "preferred",
      fixedTime: false,
    };
  }

  if (template.kind === "practical") {
    return {
      name: "חלון סידורים, כביסה ותכנון המשך",
      category: "practical",
      location: dayArea || input.countryName,
      shortDescription: "זמן ייעודי לקניית כרטיסים, כביסה, סידורים קטנים ותכנון רגוע של הימים הבאים.",
      slot: "morning",
      plannedStartTime: "09:30",
      estimatedDurationMinutes: 75,
      approximatePrice: null,
      pricePerPerson: null,
      priceOriginalAmount: null,
      priceOriginalCurrency: null,
      priceConvertedAmount: null,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: null,
      travelMinutes: 0,
      openingHours: "לא זמין",
      lastEntryTime: "",
      canonicalPlaceId: "",
      reservationRequired: false,
      transportation: "הליכה",
      mapLink: buildMapLink(dayArea || input.countryName, null, null),
      lat: null,
      lon: null,
      bookingWarning: "",
      alternativeSuggestion: "",
      recommendationId: null,
      locked: false,
      priority: "preferred",
      fixedTime: false,
    };
  }

  return null;
}

function buildFallbackAlternative(
  pool: TripRecommendation[],
  currentItems: AiGeneratedItem[],
  category: RecommendationCategory,
  preferredArea: string,
  usageCounts: Map<string, number>
) {
  const excludedIds = new Set(currentItems.map((item) => item.recommendationId).filter(Boolean) as string[]);
  const allowMealSwap = category === "restaurant" || category === "cafe";

  return pool
    .filter((candidate) => !excludedIds.has(candidate.id))
    .filter((candidate) =>
      allowMealSwap ? FALLBACK_FOOD_CATEGORIES.has(candidate.category) : candidate.category === category
    )
    .sort((left, right) => {
      const rightArea = fallbackAreaLabel(right.location).toLowerCase() === preferredArea.toLowerCase() ? 1 : 0;
      const leftArea = fallbackAreaLabel(left.location).toLowerCase() === preferredArea.toLowerCase() ? 1 : 0;
      if (rightArea !== leftArea) return rightArea - leftArea;
      return (usageCounts.get(left.id) ?? 0) - (usageCounts.get(right.id) ?? 0);
    })[0]?.name ?? "";
}

export function buildFallbackAiItinerary(input: AiItineraryRequest): AiItineraryResponse {
  const dayCount = Math.max(
    input.existingDays.length || 0,
    getTripDayCount(input.preferences.startDate, input.preferences.endDate, 3)
  );
  const recommendationPool = sanitizeCandidates([...input.selectedPlaces, ...input.recommendations]);
  const days: AiGeneratedDay[] = [];
  const areaRankings = buildFallbackAreaRankings(recommendationPool);
  const usageCounts = new Map<string, number>();
  // Real bug found in live production use: the SAME real place can appear
  // under multiple different candidate ids (fetched once per category —
  // e.g. "Old Jaffa" showing up as both an "attraction" and a "hidden_gem"
  // entry with two distinct ids). usageCounts alone (keyed by id) doesn't
  // catch that; this tracks the same fuzzy name+coordinate identity
  // collectPlanDiagnostics itself uses to flag duplicates, so a place
  // already used under ANY id is excluded, not just the exact same id.
  const usedRealPlaces: FuzzyPlaceRecord[] = [];
  const selectedIds = new Set(input.selectedPlaces.map((place) => place.id));
  const preferredKeywords = parsePreferenceKeywords(
    [input.preferences.preferredRegions, input.preferences.mustVisitPlaces, input.preferences.interests].join(",")
  );
  const avoidKeywords = parsePreferenceKeywords(input.preferences.placesToAvoid);
  const baseStayLength = dayCount >= 14 ? 3 : dayCount > 7 ? 2 : 1;

  for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
    const items: AiGeneratedItem[] = [];
    const template = buildFallbackDayTemplate(input, recommendationPool, dayNumber, dayCount);
    const baseAreaIndex = Math.floor((dayNumber - 1) / baseStayLength) % Math.max(areaRankings.length, 1);
    const preferredArea =
      areaRankings[template.kind === "transfer" && areaRankings.length > 1 ? (baseAreaIndex + 1) % areaRankings.length : baseAreaIndex] ??
      fallbackAreaLabel(input.preferences.accommodationArea) ??
      "";
    const usedToday = new Set<string>();

    const practicalItem = createFallbackPracticalItem(template, preferredArea, input);
    if (practicalItem) {
      items.push(practicalItem);
    }

    for (const slot of template.slots) {
      if (items.length >= template.maxStops) break;

      const previousItem = items.at(-1) ?? null;
      const next = selectFallbackCandidate({
        pool: recommendationPool,
        slot,
        template,
        preferredArea,
        previousItem,
        existingItems: items,
        usedToday,
        usageCounts,
        usedRealPlaces,
        selectedIds,
        preferredKeywords,
        avoidKeywords,
      });

      if (!next) {
        if (slot === "lunch" || slot === "dinner") {
          items.push(createFallbackMealPlaceholder(slot, preferredArea, input, dayNumber));
        } else if (items.length < template.maxStops) {
          // Real bug found during end-to-end QA generation: when the
          // candidate pool has no real match for a non-meal slot (most
          // starkly when the pool is empty entirely, e.g. every
          // recommendation source failed), nothing at all used to be
          // pushed here — meal slots always got a generic placeholder,
          // but anchor slots silently stayed empty. A live 10-day Israel
          // fallback run collapsed to just "lunch, dinner" on 7 of 10
          // days: no anchor, no evening coverage, the day effectively
          // ending at ~14:00. A generic exploration placeholder keeps the
          // day structurally real (spec item 6's evening-coverage
          // expectation, item 5's day-utilization floor) even with zero
          // real candidates, instead of a silent gap.
          items.push(createFallbackActivityPlaceholder(slot, preferredArea, input, dayNumber));
        }
        continue;
      }

      usedToday.add(next.id);
      usageCounts.set(next.id, (usageCounts.get(next.id) ?? 0) + 1);
      usedRealPlaces.push({ nameSlug: normalizePlaceNameSlug(next.name), lat: next.lat, lon: next.lon });

      const transportation = resolveFallbackTransportation(previousItem, next, input);
      const travelMinutes = estimateFallbackTravelMinutes(previousItem, next, input, template, transportation);

      items.push({
        name: next.name,
        category: next.category,
        location: next.location,
        shortDescription: buildFallbackItemDescription(next, slot, template, preferredArea),
        slot: slot === "lunch" && next.category === "restaurant" ? "lunch" : slot,
        plannedStartTime: slotTime(slot),
        estimatedDurationMinutes:
          next.estimatedDurationMinutes ?? (slot === "lunch" || slot === "dinner" ? 75 : slot === "evening" ? 90 : 120),
        approximatePrice: next.approximatePrice,
        // TripRecommendation doesn't carry a per-person/total distinction
        // (its own price-source semantics aren't audited yet — see
        // resolveItemPriceFields), so this is left unknown rather than
        // guessed.
        pricePerPerson: null,
        priceOriginalAmount: next.priceOriginalAmount ?? next.approximatePrice,
        priceOriginalCurrency: next.priceOriginalCurrency ?? null,
        priceConvertedAmount: next.priceConvertedAmount ?? next.approximatePrice,
        priceExchangeRate: next.priceExchangeRate ?? null,
        priceRateTimestamp: next.priceRateTimestamp ?? null,
        convertedCurrency: next.convertedCurrency ?? null,
        sourceType: next.sourceType ?? (next.approximatePrice != null ? "candidate" : null),
        travelMinutes,
        openingHours: next.openingHours || "לא זמין",
        lastEntryTime: "",
        canonicalPlaceId: deriveCanonicalPlaceId(next.id, next.lat, next.lon),
        reservationRequired: next.reservationRequired,
        transportation,
        mapLink: next.mapLink || buildMapLink(next.name, next.lat, next.lon),
        lat: next.lat,
        lon: next.lon,
        bookingWarning:
          next.reservationRequired
            ? "מומלץ לשריין מקום מראש."
            : template.kind === "transfer" && slot === "afternoon"
              ? "עדיף להשאיר מרווח אחרי המעבר לפני שמתחייבים לפעילות נוספת."
              : "",
        alternativeSuggestion: buildFallbackAlternative(
          recommendationPool,
          [...items],
          next.category,
          preferredArea,
          usageCounts
        ),
        recommendationId: next.id,
        locked: false,
        priority: "preferred",
        fixedTime: false,
      });
    }

    if (items.length === 0) {
      items.push({
        name: `חקר חופשי ב${input.countryName}`,
        category: "attraction",
        location: input.countryName,
        shortDescription: "יום פתוח לגילוי ספונטני, קפה טוב ונקודות עניין קרובות.",
        slot: "morning",
        plannedStartTime: "10:00",
        estimatedDurationMinutes: 180,
        approximatePrice: null,
        pricePerPerson: null,
        priceOriginalAmount: null,
        priceOriginalCurrency: null,
        priceConvertedAmount: null,
        priceExchangeRate: null,
        priceRateTimestamp: null,
        convertedCurrency: null,
        sourceType: null,
        travelMinutes: 0,
        openingHours: "",
        lastEntryTime: "",
        canonicalPlaceId: "",
        reservationRequired: false,
        transportation: input.preferences.transportationPreferences || "תחבורה מקומית",
        mapLink: buildMapLink(input.countryName, null, null),
        lat: null,
        lon: null,
        bookingWarning: "",
        alternativeSuggestion: "",
        recommendationId: null,
        locked: false,
        priority: "preferred",
        fixedTime: false,
      });
    }

    const cityRegion =
      preferredArea ||
      fallbackAreaLabel(
        items.find((item) => item.category !== "restaurant" && item.category !== "cafe")?.location || items[0]?.location || input.countryName
      );
    const estimatedCost = items.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
    const totalTravelMinutes = items.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);
    const transportCost =
      items
        .filter((item) => item.category === "transportation")
        .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0) || null;
    const activityCost =
      items
        .filter((item) => !FALLBACK_FOOD_CATEGORIES.has(item.category) && item.category !== "transportation")
        .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0) || null;
    const foodCost =
      items
        .filter((item) => FALLBACK_FOOD_CATEGORIES.has(item.category))
        .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0) || null;
    const warnings = buildWarnings(items, input.preferences.tripPace);
    if (template.kind === "transfer") {
      warnings.push("זה יום מעבר, אז עדיף לא לדחוס יותר מדי פעילויות קשיחות בזמן.");
    }
    if (template.kind === "nightlife") {
      warnings.push("אם חוזרים מאוחר, עדיף לסיים את הערב באזור שקל ממנו לחזור ללינה.");
    }
    const nearbyRestaurantSuggestion =
      buildFallbackAlternative(recommendationPool, items, "restaurant", preferredArea, usageCounts) ||
      "";
    const anchorCategory =
      items.find((item) => !FALLBACK_FOOD_CATEGORIES.has(item.category) && item.category !== "transportation")?.category ??
      "attraction";
    const alternatives = [
      nearbyRestaurantSuggestion,
      buildFallbackAlternative(recommendationPool, items, anchorCategory, preferredArea, usageCounts),
    ].filter(Boolean);
    const transportSegments = items.reduce<string[]>((segments, item, index) => {
      if (index === 0 || (item.travelMinutes ?? 0) <= 0) return segments;
      const previous = items[index - 1];
      segments.push(
        `${previous.location || cityRegion} -> ${item.location || item.name} · ${item.transportation || "תחבורה מקומית"} · ${item.travelMinutes} דק'`
      );
      return segments;
    }, []);
    const bookingRequirements = items
      .filter((item) => item.reservationRequired)
      .map((item) => `${item.name}: מומלץ להזמין מראש.`);
    if (template.kind === "transfer") {
      bookingRequirements.unshift("בדקו צ'ק-אאוט, אחסון מזוודות ושעת הגעה ללינה הבאה.");
    }
    if (template.kind === "practical") {
      bookingRequirements.unshift("זה יום טוב להשלים הזמנות, כרטיסים וארגון לוגיסטי להמשך.");
    }

    days.push({
      dayNumber,
      date:
        input.existingDays[dayNumber - 1]?.date || dateForDayNumber(input.preferences.startDate, dayNumber),
      title: `יום ${dayNumber} · ${template.titleHint}${cityRegion ? ` ב${cityRegion}` : ""}`,
      // Left empty here — every path that reaches a saved itinerary passes
      // fallback days through fillDerivedDayFields (country-itinerary-generation.ts),
      // which always recomputes theme from the day's actual items.
      theme: "",
      cityRegion,
      accommodation:
        input.preferences.accommodationArea ||
        (cityRegion ? `בסיס לינה באזור ${cityRegion}` : ""),
      notes: `${template.notes}${cityRegion ? ` היום בנוי סביב ${cityRegion}` : ""} כדי לשמור על קצב טבעי, אוכל קרוב ומעברים הגיוניים.`,
      transportation: input.preferences.transportationPreferences || "תחבורה מקומית",
      estimatedCost: estimatedCost > 0 ? estimatedCost : null,
      activityCost,
      foodCost,
      transportCost,
      accommodationCost: null,
      totalTravelMinutes: totalTravelMinutes > 0 ? totalTravelMinutes : null,
      warnings,
      alternatives,
      bookingRequirements,
      safetyNotes:
        template.kind === "nightlife"
          ? ["בדקו מסלול חזרה בטוח ללינה אם נשארים מאוחר."]
          : [],
      restWindow:
        template.restWindow ||
        (input.preferences.tripPace === "relaxed"
          ? "המסלול כולל שוליים לגמישות, קפה טוב או מנוחה קצרה בין העצירות."
          : ""),
      transportSegments,
      items,
    });
  }

  const totalEstimatedCost = days.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0) || null;
  const estimatedTransportCost =
    days.reduce((sum, day) => sum + (day.transportCost ?? 0), 0) || null;

  return {
    summary:
      input.tripStatus === "currently_traveling"
        ? "נבנה מסלול פרקטי להמשך הימים הקרובים עם דגש על קצב, אזורים, אוכל קרוב ואפשרויות גיבוי."
        : "נבנה מסלול יום-אחר-יום שמרגיש כמו טיול עצמאי אמיתי: אזורים שונים, קצב משתנה, אוכל קרוב ולוגיסטיקה פרקטית.",
    title: `${input.countryName}: ${formatTripDateRange(input.preferences.startDate, input.preferences.endDate, input.preferences.partialDate)}`,
    totalEstimatedCost,
    estimatedTransportCost,
    averageDailyCost:
      totalEstimatedCost != null && days.length > 0 ? Math.round(totalEstimatedCost / days.length) : null,
    costPerTraveler:
      totalEstimatedCost != null && input.preferences.travelers > 0
        ? Math.round(totalEstimatedCost / input.preferences.travelers) || null
        : null,
    categoryBreakdown: {
      attractions: days.reduce((sum, day) => sum + (day.activityCost ?? 0), 0),
      food: days.reduce((sum, day) => sum + (day.foodCost ?? 0), 0),
      transportation: estimatedTransportCost ?? 0,
      accommodation: days.reduce((sum, day) => sum + (day.accommodationCost ?? 0), 0),
      other: 0,
    },
    days,
  };
}

// Items have no stable id across regenerations (the AI rebuilds the whole
// plan), so we match previous items by recommendationId first, falling back
// to name+location — the same heuristic `findItineraryPlacement` already
// uses — to decide whether a lock/priority/fixedTime flag the user set
// should survive onto the newly generated item.
function buildPreviousItemLookup(days: TripItineraryDay[]) {
  const byRecommendationId = new Map<string, TripItineraryItem>();
  const byNameLocation = new Map<string, TripItineraryItem>();
  for (const day of days) {
    for (const item of day.items) {
      if (item.recommendationId) byRecommendationId.set(item.recommendationId, item);
      byNameLocation.set(`${item.name.toLowerCase()}::${item.location.toLowerCase()}`, item);
    }
  }
  return { byRecommendationId, byNameLocation };
}

function findPreviousItem(
  lookup: ReturnType<typeof buildPreviousItemLookup>,
  item: Pick<AiGeneratedItem, "recommendationId" | "name" | "location">
) {
  if (item.recommendationId) {
    const match = lookup.byRecommendationId.get(item.recommendationId);
    if (match) return match;
  }
  return lookup.byNameLocation.get(`${item.name.toLowerCase()}::${item.location.toLowerCase()}`) ?? null;
}

export function applyAiPlanToWorkspace(
  current: CountryTripWorkspaceState,
  plan: AiItineraryResponse
): CountryTripWorkspaceState {
  const previousItemLookup = buildPreviousItemLookup(current.itineraryDays);
  // Old item id -> new item id, for items matched by recommendationId/name+location
  // (see findPreviousItem above) — used below to keep booking/document links
  // pointed at the right item instead of a stale id after regeneration.
  const itemIdRemap = new Map<string, string>();

  const nextDays = plan.days.map((day) => ({
    ...createEmptyDay(day.dayNumber, day.date),
    id: current.itineraryDays[day.dayNumber - 1]?.id ?? createId("day"),
    dayNumber: day.dayNumber,
    title: day.title,
    theme: day.theme,
    date: day.date,
    cityRegion: day.cityRegion,
    accommodation: day.accommodation,
    accommodationMapLink: current.itineraryDays[day.dayNumber - 1]?.accommodationMapLink ?? "",
    accommodationLat: current.itineraryDays[day.dayNumber - 1]?.accommodationLat ?? null,
    accommodationLon: current.itineraryDays[day.dayNumber - 1]?.accommodationLon ?? null,
    notes: day.notes,
    transportation: day.transportation,
    estimatedCost: day.estimatedCost,
    activityCost: day.activityCost,
    foodCost: day.foodCost,
    transportCost: day.transportCost,
    accommodationCost: day.accommodationCost,
    totalTravelMinutes: day.totalTravelMinutes,
    warnings: day.warnings,
    alternatives: day.alternatives,
    bookingRequirements: day.bookingRequirements,
    safetyNotes: day.safetyNotes,
    restWindow: day.restWindow,
    transportSegments: day.transportSegments,
    items: day.items.map((item) => {
      const previous = findPreviousItem(previousItemLookup, item);
      const nextItem = {
        ...createEmptyItineraryItem(item.slot),
        recommendationId: item.recommendationId,
        name: item.name,
        category: item.category,
        location: item.location,
        shortDescription: item.shortDescription,
        slot: item.slot,
        plannedStartTime: item.plannedStartTime,
        endTime: item.endTime,
        estimatedDurationMinutes: item.estimatedDurationMinutes,
        approximatePrice: item.approximatePrice,
        pricePerPerson: item.pricePerPerson,
        priceOriginalAmount: item.priceOriginalAmount,
        priceOriginalCurrency: item.priceOriginalCurrency,
        priceConvertedAmount: item.priceConvertedAmount,
        priceExchangeRate: item.priceExchangeRate,
        priceRateTimestamp: item.priceRateTimestamp,
        convertedCurrency: item.convertedCurrency,
        sourceType: item.sourceType,
        travelMinutes: item.travelMinutes,
        transportation: item.transportation,
        openingHours: item.openingHours,
        lastEntryTime: item.lastEntryTime,
        canonicalPlaceId: item.canonicalPlaceId,
        reservationRequired: item.reservationRequired,
        mapLink: item.mapLink,
        lat: item.lat,
        lon: item.lon,
        alternativeSuggestion: item.alternativeSuggestion,
        bookingWarning: item.bookingWarning,
        locked: previous?.locked ?? item.locked,
        priority: previous?.priority ?? item.priority,
        fixedTime: previous?.fixedTime ?? item.fixedTime,
      };
      if (previous) itemIdRemap.set(previous.id, nextItem.id);
      return nextItem;
    }),
  }));

  // Keep booking/document links pointed at the regenerated item instead of a
  // stale id (spec: booking/document links must survive regeneration).
  const bookings = current.bookings.map((booking) =>
    booking.itineraryItemId && itemIdRemap.has(booking.itineraryItemId)
      ? { ...booking, itineraryItemId: itemIdRemap.get(booking.itineraryItemId)! }
      : booking
  );
  const documents = current.documents.map((document) =>
    document.itineraryItemId && itemIdRemap.has(document.itineraryItemId)
      ? { ...document, itineraryItemId: itemIdRemap.get(document.itineraryItemId)! }
      : document
  );

  return {
    ...current,
    itineraryDays: nextDays,
    bookings,
    documents,
    lastAiPlanSummary: plan.summary,
  };
}
