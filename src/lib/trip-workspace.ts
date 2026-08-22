import { differenceInCalendarDays, parseISO } from "date-fns";

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
  | "plan"
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
  dietaryPreferences: string;
  accessibilityNeeds: string;
  preferredRegions: string;
  mustVisitPlaces: string;
  placesToAvoid: string;
  safetyConstraints: string;
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
}

export interface TripItineraryDay {
  id: string;
  dayNumber: number;
  title: string;
  date: string;
  cityRegion: string;
  accommodation: string;
  accommodationMapLink: string;
  accommodationLat: number | null;
  accommodationLon: number | null;
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
}

export interface AiGeneratedItem {
  name: string;
  category: RecommendationCategory;
  location: string;
  shortDescription: string;
  slot: DayPart;
  plannedStartTime: string;
  estimatedDurationMinutes: number | null;
  approximatePrice: number | null;
  priceOriginalAmount: number | null;
  priceOriginalCurrency: string | null;
  priceConvertedAmount: number | null;
  priceExchangeRate: number | null;
  priceRateTimestamp: string | null;
  convertedCurrency: string | null;
  sourceType: PriceSourceType | null;
  travelMinutes: number | null;
  openingHours: string;
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
}

export interface AiGeneratedDay {
  dayNumber: number;
  date: string;
  title: string;
  cityRegion: string;
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
  plan: "תכנון",
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
  "plan",
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
      "plan",
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
      "plan",
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
  };
}

export function createEmptyDay(dayNumber: number, date = ""): TripItineraryDay {
  return {
    id: createId("day"),
    dayNumber,
    title: `Day ${dayNumber}`,
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

  score -= usageCount * 18;

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

function selectFallbackCandidate(args: {
  pool: TripRecommendation[];
  slot: DayPart;
  template: FallbackDayTemplate;
  preferredArea: string;
  previousItem: AiGeneratedItem | null;
  usedToday: Set<string>;
  usageCounts: Map<string, number>;
  selectedIds: Set<string>;
  preferredKeywords: string[];
  avoidKeywords: string[];
}) {
  const ranked = args.pool
    .filter((candidate) => !args.usedToday.has(candidate.id))
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

function createFallbackMealPlaceholder(
  slot: DayPart,
  dayArea: string,
  input: AiItineraryRequest
): AiGeneratedItem {
  const name =
    slot === "lunch"
      ? dayArea
        ? `אזור אוכל מקומי ב${dayArea}`
        : "שוק או אזור אוכל מקומי"
      : dayArea
        ? `ארוחת ערב באזור ${dayArea}`
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
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: 10,
    openingHours: "לא זמין",
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
      priceOriginalAmount: null,
      priceOriginalCurrency: null,
      priceConvertedAmount: null,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: null,
      travelMinutes: 0,
      openingHours: "לא זמין",
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
      priceOriginalAmount: null,
      priceOriginalCurrency: null,
      priceConvertedAmount: null,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: null,
      travelMinutes: 0,
      openingHours: "לא זמין",
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
        usedToday,
        usageCounts,
        selectedIds,
        preferredKeywords,
        avoidKeywords,
      });

      if (!next) {
        if (slot === "lunch" || slot === "dinner") {
          items.push(createFallbackMealPlaceholder(slot, preferredArea, input));
        }
        continue;
      }

      usedToday.add(next.id);
      usageCounts.set(next.id, (usageCounts.get(next.id) ?? 0) + 1);

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
        priceOriginalAmount: next.priceOriginalAmount ?? next.approximatePrice,
        priceOriginalCurrency: next.priceOriginalCurrency ?? null,
        priceConvertedAmount: next.priceConvertedAmount ?? next.approximatePrice,
        priceExchangeRate: next.priceExchangeRate ?? null,
        priceRateTimestamp: next.priceRateTimestamp ?? null,
        convertedCurrency: next.convertedCurrency ?? null,
        sourceType: next.sourceType ?? (next.approximatePrice != null ? "candidate" : null),
        travelMinutes,
        openingHours: next.openingHours || "לא זמין",
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
        priceOriginalAmount: null,
        priceOriginalCurrency: null,
        priceConvertedAmount: null,
        priceExchangeRate: null,
        priceRateTimestamp: null,
        convertedCurrency: null,
        sourceType: null,
        travelMinutes: 0,
        openingHours: "",
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
    title: `${input.countryName} · ${input.preferences.startDate || "ללא תאריך"}${input.preferences.endDate ? ` עד ${input.preferences.endDate}` : ""}`,
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
        estimatedDurationMinutes: item.estimatedDurationMinutes,
        approximatePrice: item.approximatePrice,
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
