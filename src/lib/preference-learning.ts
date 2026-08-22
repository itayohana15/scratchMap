import { isExplicitlyClosedText, parseOpeningHoursRange } from "@/lib/live-trip-planner";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  haversineKm,
  type RecommendationCategory,
  type TripComparison,
  type TripPreferences,
  type TripRecommendation,
} from "@/lib/trip-workspace";

export type PreferenceCategory =
  | "pace"
  | "nature"
  | "history"
  | "culture"
  | "museums"
  | "food"
  | "local_food"
  | "fine_dining"
  | "street_food"
  | "nightlife"
  | "shopping"
  | "markets"
  | "local_neighborhoods"
  | "hidden_gems"
  | "famous_landmarks"
  | "hiking"
  | "beaches"
  | "spa"
  | "theme_parks"
  | "photography"
  | "events"
  | "social"
  | "adventure"
  | "scenic_viewpoints";

export const PREFERENCE_CATEGORY_LABELS: Record<PreferenceCategory, string> = {
  pace: "קצב טיול",
  nature: "טבע",
  history: "היסטוריה",
  culture: "תרבות",
  museums: "מוזיאונים",
  food: "אוכל",
  local_food: "אוכל מקומי",
  fine_dining: "מסעדות יוקרה",
  street_food: "אוכל רחוב",
  nightlife: "חיי לילה",
  shopping: "קניות",
  markets: "שווקים",
  local_neighborhoods: "שכונות מקומיות",
  hidden_gems: "פנינים נסתרות",
  famous_landmarks: "אתרים מפורסמים",
  hiking: "טיולי הליכה",
  beaches: "חופים",
  spa: "ספא ופינוק",
  theme_parks: "פארקי שעשועים",
  photography: "צילום",
  events: "אירועים ופסטיבלים",
  social: "פעילויות חברתיות",
  adventure: "הרפתקאות",
  scenic_viewpoints: "נקודות תצפית",
};

export type PreferenceLevel = 1 | 2 | 3 | 4 | 5;

export const PREFERENCE_LEVEL_LABELS: Record<PreferenceLevel, string> = {
  1: "נמוכה מאוד",
  2: "נמוכה",
  3: "בינונית",
  4: "גבוהה",
  5: "גבוהה מאוד",
};

// item.category -> baseline PreferenceCategory buckets. "hotel"/"transportation"/
// "practical" are logistics, not interest signals, and intentionally map to
// nothing. "pace" is a trip-level signal (see derivePaceSuggestion), never
// derived from a single item.
const CATEGORY_BASE_MAP: Record<RecommendationCategory, PreferenceCategory[]> = {
  restaurant: ["food"],
  cafe: ["food", "local_food"],
  museum: ["museums", "history", "culture"],
  nature: ["nature", "scenic_viewpoints"],
  shopping: ["shopping"],
  nightlife: ["nightlife", "social"],
  family: ["social"],
  hidden_gem: ["hidden_gems", "local_neighborhoods"],
  day_trip: ["adventure", "scenic_viewpoints"],
  seasonal_event: ["events"],
  hotel: [],
  transportation: [],
  practical: [],
  attraction: ["famous_landmarks"],
};

const KEYWORD_ADDITIONS: Array<{ category: PreferenceCategory; needles: string[] }> = [
  { category: "hiking", needles: ["hiking", "hike", "טרק", "מסלול הליכה", "trail"] },
  { category: "beaches", needles: ["beach", "חוף", "snorkel", "צלילה"] },
  { category: "spa", needles: ["spa", "onsen", "ספא", "אונסן", "hot spring", "מעיינות חמים"] },
  { category: "theme_parks", needles: ["theme park", "לונה פארק", "amusement park", "דיסני", "disney"] },
  { category: "photography", needles: ["viewpoint", "lookout", "נוף", "תצפית", "photo spot"] },
  { category: "scenic_viewpoints", needles: ["viewpoint", "lookout", "נוף", "תצפית", "panorama"] },
  { category: "street_food", needles: ["street food", "אוכל רחוב", "food stall", "food truck"] },
  { category: "fine_dining", needles: ["fine dining", "gourmet", "מסעדת שף", "michelin"] },
  { category: "local_food", needles: ["local food", "אוכל מקומי", "traditional", "מסורתי"] },
  { category: "markets", needles: ["market", "שוק", "bazaar"] },
  { category: "adventure", needles: ["adventure", "אתגרי", "extreme", "zipline", "rafting"] },
  { category: "local_neighborhoods", needles: ["neighborhood", "שכונה", "local area"] },
];

function textHasAny(text: string, needles: string[]) {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

export function mapItemToPreferenceCategories(item: {
  category: RecommendationCategory;
  name: string;
  shortDescription?: string;
}): PreferenceCategory[] {
  const categories = new Set<PreferenceCategory>(CATEGORY_BASE_MAP[item.category] ?? []);
  const haystack = `${item.name} ${item.shortDescription ?? ""}`;
  for (const { category, needles } of KEYWORD_ADDITIONS) {
    if (textHasAny(haystack, needles)) categories.add(category);
  }
  return [...categories];
}

/** Same normalization for every consumer (client cards, server prompt-building) — no framework dependency, safe on both sides. */
export function buildPlaceKey(place: { name: string; location: string; lat?: number | null; lon?: number | null }) {
  if (place.lat != null && place.lon != null) {
    return `coords:${place.lat.toFixed(4)}:${place.lon.toFixed(4)}`;
  }
  return `name:${place.name.trim().toLowerCase()}::${place.location.trim().toLowerCase()}`;
}

// Skip reasons that carry no preference information (spec §4) — "closed",
// weather, schedule changes, fatigue/time are all circumstantial, not a
// signal the user dislikes the category.
const NEUTRAL_SKIP_REASONS = new Set(["אין זמן", "עייף/ה", "סגור", "מזג אוויר", "שינוי תוכניות", "אחר", "closed", "weather", "changed plans"]);

interface CategorySignal {
  positiveWeight: number;
  negativeWeight: number;
  sampleSize: number;
}

const RECENCY_HALF_LIFE_DAYS = 365;
const RECENCY_FLOOR = 0.15;

function recencyWeight(dateString: string | null, now: Date): number {
  if (!dateString) return RECENCY_FLOOR;
  const days = (now.getTime() - new Date(dateString).getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(days) || days < 0) return 1;
  const decayed = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
  return Math.max(RECENCY_FLOOR, decayed);
}

/**
 * Aggregates real Stage 4-6 behavior (completed/skipped/favorited/rated
 * items, plus explicit thumbs feedback) into per-category evidence, weighted
 * by recency (older trips never hit zero — spec §6) and by signal quality
 * (spec §4: favorite+high rating is strong, plain completion is moderate,
 * a circumstantial skip reason contributes nothing negative).
 */
export function computeBehaviorSignals(
  itineraries: CountryItineraryRecord[],
  feedbackRows: Array<{ place_key: string; category: string; feedback: "up" | "down" }> = [],
  now: Date = new Date()
): Map<PreferenceCategory, CategorySignal> {
  const signals = new Map<PreferenceCategory, CategorySignal>();

  function addSignal(category: PreferenceCategory, positive: number, negative: number) {
    const current = signals.get(category) ?? { positiveWeight: 0, negativeWeight: 0, sampleSize: 0 };
    current.positiveWeight += positive;
    current.negativeWeight += negative;
    if (positive > 0 || negative > 0) current.sampleSize += 1;
    signals.set(category, current);
  }

  for (const itinerary of itineraries) {
    if (itinerary.status !== "completed") continue;
    const weight = recencyWeight(itinerary.endDate ?? itinerary.startDate, now);

    for (const day of itinerary.itineraryDays) {
      for (const item of day.items) {
        const categories = mapItemToPreferenceCategories(item);
        if (categories.length === 0) continue;

        if (item.completed) {
          const isStrong = item.favorite || (item.personalRating ?? 0) >= 8;
          const positive = weight * (isStrong ? 1 : 0.4);
          for (const category of categories) addSignal(category, positive, 0);
        } else if (item.skipped) {
          const reason = (item.skipReason ?? "").trim();
          const isNegative = reason.length > 0 && !NEUTRAL_SKIP_REASONS.has(reason) && reason !== "";
          if (isNegative) {
            for (const category of categories) addSignal(category, 0, weight * 0.5);
          }
          // Unlabeled or circumstantial skips contribute nothing either way.
        }
      }
    }
  }

  for (const row of feedbackRows) {
    const category = row.category as PreferenceCategory;
    if (!(category in PREFERENCE_CATEGORY_LABELS)) continue;
    if (row.feedback === "up") addSignal(category, 0.6, 0);
    else addSignal(category, 0, 0.6);
  }

  return signals;
}

export interface InferredPreferenceEntry {
  level: PreferenceLevel;
  confidence: number;
  direction: "up" | "down";
  sampleSize: number;
  updatedAt: string;
}

const MIN_SAMPLE_SIZE_FOR_SUGGESTION = 4;
const MIN_GAP_FOR_SUGGESTION = 1;

export interface PreferenceSuggestion {
  category: PreferenceCategory;
  inferredLevel: PreferenceLevel;
  explicitLevel: PreferenceLevel | null;
  confidence: number;
  direction: "up" | "down";
  suggestionText: string;
}

/**
 * Only surfaces a suggestion where there's enough evidence (spec §5 — one
 * activity never produces a claim) AND a meaningful gap vs. the explicit
 * value. Never mutates explicit preferences itself — the caller decides
 * whether to accept.
 */
export function deriveInferredPreferences(
  signals: Map<PreferenceCategory, CategorySignal>,
  explicitPreferences: Record<string, number>
): { inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>>; suggestions: PreferenceSuggestion[] } {
  const inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>> = {};
  const suggestions: PreferenceSuggestion[] = [];
  const now = new Date().toISOString();

  for (const [category, signal] of signals.entries()) {
    const total = signal.positiveWeight + signal.negativeWeight;
    if (total <= 0) continue;

    const positiveShare = signal.positiveWeight / total;
    // 1 (all negative) .. 5 (all positive), centered on 3 for a 50/50 split.
    const level = Math.max(1, Math.min(5, Math.round(1 + positiveShare * 4))) as PreferenceLevel;
    const confidence = Math.min(1, signal.sampleSize / (MIN_SAMPLE_SIZE_FOR_SUGGESTION * 2));

    if (signal.sampleSize < MIN_SAMPLE_SIZE_FOR_SUGGESTION) continue;

    const explicitLevel = explicitPreferences[category] as PreferenceLevel | undefined;
    const direction: "up" | "down" = level >= (explicitLevel ?? 3) ? "up" : "down";

    inferred[category] = { level, confidence, direction, sampleSize: signal.sampleSize, updatedAt: now };

    const gap = explicitLevel != null ? Math.abs(level - explicitLevel) : null;
    if (explicitLevel != null && (gap == null || gap < MIN_GAP_FOR_SUGGESTION)) continue;
    if (confidence < 0.5) continue;

    const label = PREFERENCE_CATEGORY_LABELS[category];
    const suggestionText =
      explicitLevel == null
        ? `נראה שאתה נהנה מ${label} בטיולים שלך. להוסיף את זה להעדפות שלך ברמה "${PREFERENCE_LEVEL_LABELS[level]}"?`
        : direction === "down"
          ? `נראה שבטיולים האחרונים אתה מדלג לעיתים קרובות על ${label}. לעדכן את ההעדפה מ"${PREFERENCE_LEVEL_LABELS[explicitLevel]}" ל"${PREFERENCE_LEVEL_LABELS[level]}"?`
          : `נראה שאתה נהנה מ${label} יותר ממה שההעדפה הנוכחית משקפת. לעדכן מ"${PREFERENCE_LEVEL_LABELS[explicitLevel]}" ל"${PREFERENCE_LEVEL_LABELS[level]}"?`;

    suggestions.push({ category, inferredLevel: level, explicitLevel: explicitLevel ?? null, confidence, direction, suggestionText });
  }

  return { inferred, suggestions: suggestions.sort((a, b) => b.confidence - a.confidence) };
}

export interface VisitedPlaceInfo {
  visitedCount: number;
  lastVisitedAt: string | null;
  favorite: boolean;
  avgRating: number | null;
}

/** Repeat-visit intelligence (spec §18/19) — scoped to whatever itineraries the caller passes in (typically one country's completed trips). */
export function computeAlreadyVisited(itineraries: CountryItineraryRecord[]): Map<string, VisitedPlaceInfo> {
  const map = new Map<string, VisitedPlaceInfo>();

  for (const itinerary of itineraries) {
    if (itinerary.status !== "completed") continue;
    for (const day of itinerary.itineraryDays) {
      for (const item of day.items) {
        if (!item.completed || !item.name.trim()) continue;
        const key = buildPlaceKey(item);
        const existing = map.get(key) ?? { visitedCount: 0, lastVisitedAt: null, favorite: false, avgRating: null };
        const ratings: number[] = existing.avgRating != null ? [existing.avgRating] : [];
        if (item.personalRating != null) ratings.push(item.personalRating);
        map.set(key, {
          visitedCount: existing.visitedCount + 1,
          lastVisitedAt: day.date && (!existing.lastVisitedAt || day.date > existing.lastVisitedAt) ? day.date : existing.lastVisitedAt,
          favorite: existing.favorite || item.favorite,
          avgRating: ratings.length > 0 ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
        });
      }
    }
  }

  return map;
}

export interface FeedbackAggregate {
  upCount: number;
  downCount: number;
  reasons: string[];
}

export function aggregateFeedbackByPlace(
  feedbackRows: Array<{ place_key: string; feedback: "up" | "down"; reason: string | null }>
): Map<string, FeedbackAggregate> {
  const map = new Map<string, FeedbackAggregate>();
  for (const row of feedbackRows) {
    const current = map.get(row.place_key) ?? { upCount: 0, downCount: 0, reasons: [] };
    if (row.feedback === "up") current.upCount += 1;
    else current.downCount += 1;
    if (row.reason) current.reasons.push(row.reason);
    map.set(row.place_key, current);
  }
  return map;
}

export interface ScoreContext {
  explicitPreferences: Record<string, number>;
  inferredPreferences: Record<string, { level: number; confidence: number }>;
  feedbackByPlaceKey: Map<string, FeedbackAggregate>;
  alreadyVisited: Map<string, VisitedPlaceInfo>;
  usedCategories?: Set<RecommendationCategory>;
  anchorLat?: number | null;
  anchorLon?: number | null;
  remainingBudget?: number | null;
  nowMinutes?: number | null;
}

export interface ScoreBreakdown {
  preferenceFit: number;
  distanceScore: number;
  budgetFit: number;
  openingHoursFit: number;
  diversityContribution: number;
  userFeedbackScore: number;
  repeatVisitPenalty: number;
  hiddenGemPreference: number;
  popularity: number;
  total: number;
  matchedCategories: PreferenceCategory[];
}

const SCORE_WEIGHTS = {
  preferenceFit: 0.26,
  distanceScore: 0.2,
  budgetFit: 0.15,
  diversityContribution: 0.1,
  userFeedbackScore: 0.12,
  repeatVisitPenalty: 0.1,
  hiddenGemPreference: 0.05,
  // No popularity/review-count field exists on TripRecommendation today —
  // kept at zero weight rather than fabricated, per spec §17's own warning
  // not to let popularity dominate personalization.
  popularity: 0,
};

function levelToUnit(level: number) {
  return Math.max(0, Math.min(1, (level - 1) / 4));
}

/**
 * Deterministic scoring — no AI. Opening-hours acts as a hard constraint
 * where reliably parseable (spec §17), collapsing the total rather than
 * excluding the candidate outright (the caller decides the cutoff).
 */
export function computeRecommendationScore(
  candidate: Pick<TripRecommendation, "name" | "location" | "category" | "shortDescription" | "approximatePrice" | "openingHours" | "lat" | "lon">,
  context: ScoreContext
): ScoreBreakdown {
  const matchedCategories = mapItemToPreferenceCategories(candidate);
  const placeKey = buildPlaceKey(candidate);

  const preferenceFit =
    matchedCategories.length === 0
      ? 0.5
      : matchedCategories.reduce((sum, category) => {
          const explicit = context.explicitPreferences[category];
          const inferred = context.inferredPreferences[category];
          if (explicit != null) return sum + levelToUnit(explicit);
          if (inferred != null) return sum + levelToUnit(inferred.level) * inferred.confidence + 0.5 * (1 - inferred.confidence);
          return sum + 0.5;
        }, 0) / matchedCategories.length;

  const distanceScore = (() => {
    if (context.anchorLat == null || context.anchorLon == null || candidate.lat == null || candidate.lon == null) return 0.5;
    const km = haversineKm(context.anchorLat, context.anchorLon, candidate.lat, candidate.lon);
    return Math.max(0, 1 - km / 20);
  })();

  const budgetFit = (() => {
    if (context.remainingBudget == null || candidate.approximatePrice == null) return 0.5;
    if (context.remainingBudget <= 0) return candidate.approximatePrice === 0 ? 1 : 0.1;
    const ratio = candidate.approximatePrice / context.remainingBudget;
    return Math.max(0, 1 - ratio);
  })();

  const openingHoursFit = (() => {
    if (!candidate.openingHours) return 0.5;
    if (isExplicitlyClosedText(candidate.openingHours)) return 0;
    if (context.nowMinutes == null) return 0.7;
    const range = parseOpeningHoursRange(candidate.openingHours);
    if (!range) return 0.6;
    return context.nowMinutes >= range.openMinutes && context.nowMinutes <= range.closeMinutes ? 1 : 0.2;
  })();

  const diversityContribution = context.usedCategories?.has(candidate.category) ? 0.3 : 0.8;

  const feedback = context.feedbackByPlaceKey.get(placeKey);
  const userFeedbackScore = feedback
    ? Math.max(0, Math.min(1, 0.5 + 0.15 * (feedback.upCount - feedback.downCount)))
    : 0.5;

  const visited = context.alreadyVisited.get(placeKey);
  const repeatVisitPenalty = !visited ? 0.6 : visited.favorite ? 0.55 : visited.avgRating != null && visited.avgRating < 5 ? 0.05 : 0.15;

  const hiddenGemPreference =
    candidate.category === "hidden_gem" ? levelToUnit(context.explicitPreferences.hidden_gems ?? 3) : 0.5;

  const total =
    preferenceFit * SCORE_WEIGHTS.preferenceFit +
    distanceScore * SCORE_WEIGHTS.distanceScore +
    budgetFit * SCORE_WEIGHTS.budgetFit +
    diversityContribution * SCORE_WEIGHTS.diversityContribution +
    userFeedbackScore * SCORE_WEIGHTS.userFeedbackScore +
    repeatVisitPenalty * SCORE_WEIGHTS.repeatVisitPenalty +
    hiddenGemPreference * SCORE_WEIGHTS.hiddenGemPreference;

  const openingHoursGate = openingHoursFit === 0 ? 0.05 : 1;

  return {
    preferenceFit,
    distanceScore,
    budgetFit,
    openingHoursFit,
    diversityContribution,
    userFeedbackScore,
    repeatVisitPenalty,
    hiddenGemPreference,
    popularity: 0.5,
    total: total * openingHoursGate,
    matchedCategories,
  };
}

/** Grounded explanation — only mentions a factor that actually contributed meaningfully (spec §15: never fabricate). */
export function explainRecommendation(
  candidate: Pick<TripRecommendation, "name">,
  breakdown: ScoreBreakdown,
  explicitPreferences: Record<string, number>
): string {
  const reasons: string[] = [];

  const strongCategories = breakdown.matchedCategories.filter((category) => (explicitPreferences[category] ?? 0) >= 4);
  if (strongCategories.length > 0) {
    reasons.push(`הגדרת עניין גבוה ב${strongCategories.map((c) => PREFERENCE_CATEGORY_LABELS[c]).join(", ")}`);
  }
  if (breakdown.distanceScore >= 0.8) {
    reasons.push("הוא קרוב למסלול המתוכנן");
  }
  if (breakdown.budgetFit >= 0.8) {
    reasons.push("המחיר שלו מתאים לתקציב שנשאר");
  }
  if (breakdown.userFeedbackScore > 0.6) {
    reasons.push("דירגת לחיוב מקומות דומים בעבר");
  }
  if (breakdown.repeatVisitPenalty >= 0.55 && breakdown.repeatVisitPenalty < 0.6) {
    reasons.push("כבר ביקרת שם וסימנת כמועדף");
  } else if (breakdown.repeatVisitPenalty >= 0.6) {
    reasons.push("עוד לא ביקרת שם");
  }
  if (breakdown.hiddenGemPreference >= 0.75) {
    reasons.push("הגדרת עניין גבוה בפנינים נסתרות");
  }

  if (reasons.length === 0) {
    return `${candidate.name} עשוי להתאים למסלול הנוכחי, אך אין עדיין מספיק מידע כדי להסביר את ההתאמה בביטחון.`;
  }

  return `מומלץ לך כי ${reasons.join(", ")}.`;
}

/**
 * Compact, capped summary for the Gemini prompt (spec §50/51) — never the
 * full history, just the strongest signals.
 */
export function buildPersonalizationSummary(
  explicitPreferences: Record<string, number>,
  inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>>,
  recentNegativeFeedback: Array<{ category: string; reason: string | null }> = []
): string | null {
  const parts: string[] = [];

  const strongExplicit = Object.entries(explicitPreferences)
    .filter(([, level]) => level >= 4)
    .slice(0, 6)
    .map(([category, level]) => `${PREFERENCE_CATEGORY_LABELS[category as PreferenceCategory] ?? category}: ${PREFERENCE_LEVEL_LABELS[level as PreferenceLevel]}`);
  if (strongExplicit.length > 0) parts.push(`Explicit high-interest: ${strongExplicit.join(", ")}`);

  const acceptedLearned = Object.entries(inferred)
    .filter(([, entry]) => entry.confidence >= 0.6)
    .slice(0, 4)
    .map(([category, entry]) => `${PREFERENCE_CATEGORY_LABELS[category as PreferenceCategory]} ${entry.direction === "up" ? "↑" : "↓"}`);
  if (acceptedLearned.length > 0) parts.push(`Learned: ${acceptedLearned.join(", ")}`);

  const negatives = recentNegativeFeedback
    .slice(0, 3)
    .map((entry) => `${entry.category}${entry.reason ? ` (${entry.reason})` : ""}`);
  if (negatives.length > 0) parts.push(`Recent negative feedback: ${negatives.join(", ")}`);

  if (parts.length === 0) return null;
  return parts.join(". ");
}

export interface CategoryCount {
  category: RecommendationCategory;
  label: string;
  count: number;
}

/**
 * Deterministic, post-generation only — lists a bullet ONLY when it's
 * genuinely true of the real output, never assumed (spec §29).
 */
export function explainPersonalizationInGeneration(
  categoryBreakdown: CategoryCount[],
  explicitPreferences: Record<string, number>
): string[] {
  const totalCount = categoryBreakdown.reduce((sum, entry) => sum + entry.count, 0);
  if (totalCount === 0) return [];
  const baselineShare = 1 / Math.max(1, categoryBreakdown.length);

  const bullets: string[] = [];
  for (const entry of categoryBreakdown) {
    const preferenceCategories = mapItemToPreferenceCategories({ category: entry.category, name: "", shortDescription: "" });
    const share = entry.count / totalCount;
    const explicitLevel = preferenceCategories.map((category) => explicitPreferences[category]).find((level) => level != null);
    if (explicitLevel != null && explicitLevel >= 4 && share > baselineShare * 1.3) {
      bullets.push(`יותר ${entry.label}`);
    }
    if (explicitLevel != null && explicitLevel <= 2 && share < baselineShare * 0.7 && entry.count > 0) {
      bullets.push(`פחות ${entry.label}`);
    }
  }
  return bullets.slice(0, 5);
}

/** Pace learning (spec §23) — planned vs. actual completion, trip-level, never per-item. */
export function derivePaceSuggestion(
  comparison: Pick<TripComparison, "plannedActivities" | "completedActivities">,
  plannedPace: TripPreferences["tripPace"]
): string | null {
  if (plannedPace !== "fast" || comparison.plannedActivities === 0) return null;
  const completionRatio = comparison.completedActivities / comparison.plannedActivities;
  if (completionRatio >= 0.75) return null;
  return `נראה שקצב "אינטנסיבי" עמוס מדי עבורך (הושלמו כ-${Math.round(completionRatio * 100)}% מהמתוכנן). לנסות "מאוזן" בטיול הבא?`;
}

/** Budget learning (spec §24) — category-level planned-vs-actual drift, trip-level suggestion only. */
export function deriveBudgetSuggestion(
  categoryDrifts: Array<{ category: string; label: string; planned: number; actual: number; hasActualData: boolean }>
): string | null {
  const foodDrift = categoryDrifts.find((entry) => entry.category === "food" && entry.hasActualData && entry.planned > 0);
  if (!foodDrift) return null;
  const overBy = (foodDrift.actual - foodDrift.planned) / foodDrift.planned;
  if (overBy < 0.2) return null;
  return `בדרך כלל אתה מוציא יותר על אוכל מהתקציב הראשוני (כ-${Math.round(overBy * 100)}% יותר). להקצות יותר למסעדות בטיול הבא?`;
}
