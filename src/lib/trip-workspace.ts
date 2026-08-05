import { differenceInCalendarDays, parseISO } from "date-fns";

export type TripPhase = "planning" | "booked" | "currently_traveling" | "completed";

export type TripWorkspaceTab =
  | "overview"
  | "plan"
  | "itinerary"
  | "map"
  | "recommendations"
  | "budget"
  | "journal"
  | "photos"
  | "summary"
  | "practical";

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
  | "transportation";

export type DayPart = "morning" | "lunch" | "afternoon" | "dinner" | "evening" | "night";

export type ExpenseCategory =
  | "accommodation"
  | "food"
  | "attractions"
  | "local_transportation"
  | "flights"
  | "shopping"
  | "other";

export type BookingType = "flight" | "hotel" | "restaurant" | "activity" | "transport";
export type BookingStatus = "pending" | "confirmed" | "completed";

export interface TripPreferences {
  startDate: string;
  endDate: string;
  travelers: number;
  budget: number | null;
  tripStyle: string;
  tripPace: "relaxed" | "balanced" | "fast";
  interests: string;
  transportationPreferences: string;
  accommodationArea: string;
  dietaryPreferences: string;
  accessibilityNeeds: string;
}

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
  mapLink: string;
  imageUrl: string;
  imageQuery: string;
  lat: number | null;
  lon: number | null;
  source: "saved" | "manual" | "api" | "database" | "ai";
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
  actualStartTime: string;
  estimatedDurationMinutes: number | null;
  approximatePrice: number | null;
  actualCost: number | null;
  travelMinutes: number | null;
  transportation: string;
  openingHours: string;
  reservationRequired: boolean;
  bookingCompleted: boolean;
  optional: boolean;
  completed: boolean;
  skipped: boolean;
  plannedNotes: string;
  journalNotes: string;
  mapLink: string;
  lat: number | null;
  lon: number | null;
  alternativeSuggestion: string;
  bookingWarning: string;
  spontaneous: boolean;
}

export interface TripItineraryDay {
  id: string;
  dayNumber: number;
  title: string;
  date: string;
  notes: string;
  transportation: string;
  items: TripItineraryItem[];
}

export interface TripBooking {
  id: string;
  name: string;
  type: BookingType;
  date: string;
  time: string;
  reference: string;
  status: BookingStatus;
  notes: string;
}

export interface TripExpense {
  id: string;
  category: ExpenseCategory;
  label: string;
  amount: number;
  date: string;
  dayId: string | null;
  notes: string;
}

export interface TripJournalEntry {
  id: string;
  dayId: string;
  date: string;
  dailySummary: string;
  notes: string;
  placesActuallyVisited: string;
  activitiesSkipped: string;
  favoriteMoment: string;
  moodRating: number | null;
  weatherNotes: string;
}

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

export interface CountryTripWorkspaceState {
  version: 1;
  tripStatus: TripPhase;
  preferences: TripPreferences;
  recommendations: TripRecommendation[];
  itineraryDays: TripItineraryDay[];
  bookings: TripBooking[];
  estimatedExpenses: TripExpense[];
  actualExpenses: TripExpense[];
  journalEntries: TripJournalEntry[];
  memories: TripMemoryPhoto[];
  summary: TripSummary;
  lastAiPlanSummary: string;
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
  countryName: string;
  isoA2: string;
  tripStatus: TripPhase;
  preferences: TripPreferences;
  selectedPlaces: TripRecommendation[];
  recommendations: TripRecommendation[];
  existingDays: TripItineraryDay[];
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
}

export interface AiGeneratedDay {
  dayNumber: number;
  date: string;
  title: string;
  notes: string;
  transportation: string;
  estimatedCost: number | null;
  totalTravelMinutes: number | null;
  warnings: string[];
  nearbyRestaurantSuggestion: string;
  items: AiGeneratedItem[];
}

export interface AiItineraryResponse {
  summary: string;
  days: AiGeneratedDay[];
}

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
  journal: "יומן",
  photos: "תמונות",
  summary: "סיכום",
  practical: "מידע שימושי",
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
  hotel: "מלון",
  restaurant: "מסעדה",
  activity: "פעילות",
  transport: "תחבורה",
};

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending: "ממתין",
  confirmed: "מאושר",
  completed: "בוצע",
};

export const DEFAULT_TAB_ORDER: TripWorkspaceTab[] = [
  "overview",
  "plan",
  "itinerary",
  "map",
  "recommendations",
  "budget",
  "journal",
  "photos",
  "summary",
  "practical",
];

const PACE_ACTIVITY_LIMITS: Record<TripPreferences["tripPace"], number> = {
  relaxed: 3,
  balanced: 4,
  fast: 5,
};

const AI_SLOT_ORDER: DayPart[] = ["morning", "lunch", "afternoon", "dinner", "evening"];

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
      "journal",
      "budget",
      "plan",
      "recommendations",
      "photos",
      "summary",
      "practical",
    ];
  }

  if (status === "completed") {
    return [
      "overview",
      "summary",
      "photos",
      "journal",
      "budget",
      "plan",
      "recommendations",
      "map",
      "itinerary",
      "practical",
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
    actualStartTime: "",
    estimatedDurationMinutes: null,
    approximatePrice: null,
    actualCost: null,
    travelMinutes: null,
    transportation: "",
    openingHours: "",
    reservationRequired: false,
    bookingCompleted: false,
    optional: false,
    completed: false,
    skipped: false,
    plannedNotes: "",
    journalNotes: "",
    mapLink: "",
    lat: null,
    lon: null,
    alternativeSuggestion: "",
    bookingWarning: "",
    spontaneous: false,
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
    notes: "",
    transportation: "",
    items: [],
  };
}

export function createJournalEntry(dayId: string, date = ""): TripJournalEntry {
  return {
    id: createId("journal"),
    dayId,
    date,
    dailySummary: "",
    notes: "",
    placesActuallyVisited: "",
    activitiesSkipped: "",
    favoriteMoment: "",
    moodRating: null,
    weatherNotes: "",
  };
}

export function createDefaultWorkspace(countryName: string): CountryTripWorkspaceState {
  return {
    version: 1,
    tripStatus: "planning",
    preferences: {
      startDate: "",
      endDate: "",
      travelers: 2,
      budget: null,
      tripStyle: "חוויות מגוונות",
      tripPace: "balanced",
      interests: "",
      transportationPreferences: "",
      accommodationArea: "",
      dietaryPreferences: "",
      accessibilityNeeds: "",
    },
    recommendations: [],
    itineraryDays: [createEmptyDay(1), createEmptyDay(2), createEmptyDay(3)],
    bookings: [],
    estimatedExpenses: [],
    actualExpenses: [],
    journalEntries: [],
    memories: [],
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

export function ensureJournalEntriesForDays(
  entries: TripJournalEntry[],
  days: TripItineraryDay[]
): TripJournalEntry[] {
  const byDay = new Map(entries.map((entry) => [entry.dayId, entry]));
  return days.map((day) => {
    const existing = byDay.get(day.id);
    return existing ? { ...existing, date: day.date || existing.date } : createJournalEntry(day.id, day.date);
  });
}

export function normalizeWorkspace(
  workspace: CountryTripWorkspaceState,
  countryName: string
): CountryTripWorkspaceState {
  const base = createDefaultWorkspace(countryName);
  const days =
    workspace.itineraryDays && workspace.itineraryDays.length > 0
      ? workspace.itineraryDays.map((day, index) => ({
          ...day,
          dayNumber: index + 1,
          title: day.title || `Day ${index + 1}`,
          items: day.items ?? [],
        }))
      : base.itineraryDays;

  return {
    ...base,
    ...workspace,
    preferences: { ...base.preferences, ...workspace.preferences },
    summary: { ...base.summary, ...workspace.summary },
    itineraryDays: days,
    journalEntries: ensureJournalEntriesForDays(workspace.journalEntries ?? [], days),
  };
}

export function buildMapLink(name: string, lat: number | null, lon: number | null) {
  if (lat != null && lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }
  return name ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}` : "";
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

function firstAvailable<T>(items: T[], predicate: (item: T) => boolean) {
  const index = items.findIndex(predicate);
  if (index === -1) return null;
  return items.splice(index, 1)[0] ?? null;
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

function buildWarnings(items: AiGeneratedItem[], pace: TripPreferences["tripPace"]) {
  const warnings: string[] = [];
  const activeItems = items.filter((item) => item.name);
  const totalMinutes = activeItems.reduce(
    (sum, item) => sum + (item.estimatedDurationMinutes ?? 90) + (item.travelMinutes ?? 0),
    0
  );
  const crowdedThreshold = pace === "relaxed" ? 360 : pace === "balanced" ? 480 : 600;
  if (totalMinutes > crowdedThreshold) {
    warnings.push("היום צפוף יחסית. כדאי לשקול להזיז פעילות אחת ליום אחר.");
  }
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
  return warnings;
}

function buildAlternative(
  usedIds: Set<string>,
  pool: TripRecommendation[],
  category: RecommendationCategory
) {
  const alternative = pool.find((candidate) => candidate.category === category && !usedIds.has(candidate.id));
  return alternative?.name ?? "";
}

export function buildFallbackAiItinerary(input: AiItineraryRequest): AiItineraryResponse {
  const dayCount = Math.max(
    input.existingDays.length || 0,
    getTripDayCount(input.preferences.startDate, input.preferences.endDate, 3)
  );
  const recommendationPool = sanitizeCandidates([
    ...input.selectedPlaces,
    ...input.recommendations,
  ]);
  const available = [...recommendationPool];
  const usedIds = new Set<string>();
  const days: AiGeneratedDay[] = [];
  const activityLimit = PACE_ACTIVITY_LIMITS[input.preferences.tripPace];

  for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
    const items: AiGeneratedItem[] = [];
    let previousLat: number | null = null;
    let previousLon: number | null = null;

    for (const slot of AI_SLOT_ORDER) {
      if (items.length >= activityLimit) break;

      let next: TripRecommendation | null = null;
      if (slot === "lunch") {
        next =
          firstAvailable(available, (candidate) => candidate.category === "cafe") ??
          firstAvailable(available, (candidate) => candidate.category === "restaurant");
      } else if (slot === "dinner") {
        next = firstAvailable(available, (candidate) => candidate.category === "restaurant");
      } else if (slot === "evening") {
        next =
          firstAvailable(available, (candidate) =>
            candidate.category === "nightlife" || candidate.category === "shopping"
          ) ??
          firstAvailable(available, (candidate) => candidate.category === "hidden_gem");
      } else {
        next =
          firstAvailable(available, (candidate) => candidate.category !== "restaurant" && candidate.category !== "hotel") ??
          firstAvailable(available, () => true);
      }

      if (!next) continue;
      usedIds.add(next.id);

      const travelMinutes = estimateTravelMinutes(
        previousLat,
        previousLon,
        next.lat,
        next.lon,
        input.preferences.tripPace,
        input.preferences.transportationPreferences
      );

      items.push({
        name: next.name,
        category: next.category,
        location: next.location,
        shortDescription: next.shortDescription || `עצירה מומלצת ב${next.location}`,
        slot: slot === "lunch" && next.category === "restaurant" ? "lunch" : slot,
        plannedStartTime: slotTime(slot),
        estimatedDurationMinutes: next.estimatedDurationMinutes ?? (slot === "lunch" || slot === "dinner" ? 75 : 120),
        approximatePrice: next.approximatePrice,
        travelMinutes,
        openingHours: next.openingHours,
        reservationRequired: next.reservationRequired,
        transportation: input.preferences.transportationPreferences || "תחבורה מקומית",
        mapLink: next.mapLink || buildMapLink(next.name, next.lat, next.lon),
        lat: next.lat,
        lon: next.lon,
        bookingWarning: next.reservationRequired ? "מומלץ לשריין מקום מראש." : "",
        alternativeSuggestion: buildAlternative(usedIds, recommendationPool, next.category),
        recommendationId: next.id,
      });

      previousLat = next.lat;
      previousLon = next.lon;
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
      });
    }

    const estimatedCost = items.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
    const totalTravelMinutes = items.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);
    const warnings = buildWarnings(items, input.preferences.tripPace);
    const nearbyRestaurantSuggestion =
      items.find((item) => item.category === "restaurant" || item.category === "cafe")?.name ??
      recommendationPool.find((candidate) => candidate.category === "restaurant" || candidate.category === "cafe")?.name ??
      "";

    days.push({
      dayNumber,
      date:
        input.existingDays[dayNumber - 1]?.date || dateForDayNumber(input.preferences.startDate, dayNumber),
      title: `Day ${dayNumber}`,
      notes:
        input.preferences.tripPace === "relaxed"
          ? "השאירו חלון לגמישות ולקצב נעים בין העצירות."
          : "התחילו בזמן כדי להרוויח את כל העצירות בלי לחץ מיותר.",
      transportation: input.preferences.transportationPreferences || "תחבורה מקומית",
      estimatedCost: estimatedCost > 0 ? estimatedCost : null,
      totalTravelMinutes: totalTravelMinutes > 0 ? totalTravelMinutes : null,
      warnings,
      nearbyRestaurantSuggestion,
      items,
    });
  }

  return {
    summary:
      input.tripStatus === "currently_traveling"
        ? "נבנה מסלול פרקטי להמשך הימים הקרובים עם דגש על קצב, מרחקים ואפשרויות גיבוי."
        : "נבנה מסלול יום-אחר-יום שמאזן בין אתרים, אוכל ולוגיסטיקה בלי להפוך למאמר כללי.",
    days,
  };
}
