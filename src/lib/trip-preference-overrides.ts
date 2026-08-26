import {
  PREFERENCE_CATEGORY_LABELS,
  PREFERENCE_LEVEL_LABELS,
  type InferredPreferenceEntry,
  type PreferenceCategory,
  type PreferenceLevel,
} from "@/lib/preference-learning";
import type { TripPreferences } from "@/lib/trip-workspace";

const ACCEPTED_LEARNED_CONFIDENCE = 0.6;
const STRONG_INTEREST_LEVEL = 4;
const MAX_DERIVED_INTERESTS = 6;
const MAX_SUMMARY_LINES = 5;

function effectiveLevel(
  category: PreferenceCategory,
  explicit: Record<string, number>,
  inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>>
): { level: PreferenceLevel | null; isInferred: boolean } {
  const explicitLevel = explicit[category] as PreferenceLevel | undefined;
  if (explicitLevel) return { level: explicitLevel, isInferred: false };

  const inferredEntry = inferred[category];
  if (inferredEntry && inferredEntry.confidence >= ACCEPTED_LEARNED_CONFIDENCE) {
    return { level: inferredEntry.level, isInferred: true };
  }

  return { level: null, isInferred: false };
}

/** Profile's `pace` category (1-5) mapped down to the trip form's 3-way pace. */
export function derivePaceFromProfile(
  explicit: Record<string, number>,
  inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>>
): TripPreferences["tripPace"] {
  const { level } = effectiveLevel("pace", explicit, inferred);
  if (level == null) return "balanced";
  if (level <= 2) return "relaxed";
  if (level >= 4) return "fast";
  return "balanced";
}

/**
 * Short Hebrew comma list of the profile's strongest interest categories
 * (excludes "pace" — that's handled separately). Same "strong signal"
 * selection as `buildPersonalizationSummary`, rendered as plain labels.
 */
export function deriveInterestsFromProfile(
  explicit: Record<string, number>,
  inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>>
): string {
  const categories = Object.keys(PREFERENCE_CATEGORY_LABELS) as PreferenceCategory[];
  const labels: string[] = [];

  for (const category of categories) {
    if (category === "pace") continue;
    const { level } = effectiveLevel(category, explicit, inferred);
    if (level != null && level >= STRONG_INTEREST_LEVEL) {
      labels.push(PREFERENCE_CATEGORY_LABELS[category]);
    }
    if (labels.length >= MAX_DERIVED_INTERESTS) break;
  }

  return labels.join(", ");
}

export interface ProfileSummaryLine {
  category: PreferenceCategory;
  label: string;
  levelLabel: string;
  isInferred: boolean;
}

/** Compact top-N rows for the "העדפות מהפרופיל שלי" summary card. */
export function buildProfileSummaryLines(
  explicit: Record<string, number>,
  inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>>
): ProfileSummaryLine[] {
  const categories = Object.keys(PREFERENCE_CATEGORY_LABELS) as PreferenceCategory[];
  const lines: ProfileSummaryLine[] = [];
  const pace = effectiveLevel("pace", explicit, inferred);
  if (pace.level != null) {
    lines.push({
      category: "pace",
      label: PREFERENCE_CATEGORY_LABELS.pace,
      levelLabel: PREFERENCE_LEVEL_LABELS[pace.level],
      isInferred: pace.isInferred,
    });
  }

  const rest: Array<{ category: PreferenceCategory; level: PreferenceLevel; isInferred: boolean }> = [];
  for (const category of categories) {
    if (category === "pace") continue;
    const { level, isInferred } = effectiveLevel(category, explicit, inferred);
    if (level != null) rest.push({ category, level, isInferred });
  }
  rest.sort((a, b) => b.level - a.level);

  for (const entry of rest.slice(0, Math.max(MAX_SUMMARY_LINES - lines.length, 0))) {
    lines.push({
      category: entry.category,
      label: PREFERENCE_CATEGORY_LABELS[entry.category],
      levelLabel: PREFERENCE_LEVEL_LABELS[entry.level],
      isInferred: entry.isInferred,
    });
  }

  return lines;
}

/** Trimmed inequality — used to decide whether a trip-specific value counts as an active override (spec §A8/§A9). */
export function hasActiveOverride(current: string, derived: string): boolean {
  return current.trim() !== derived.trim();
}
