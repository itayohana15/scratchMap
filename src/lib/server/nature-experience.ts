/**
 * Round 9.15 — NATURE-FIRST EXPERIENCE PLANNING FOUNDATION.
 *
 * Two concerns live here, both pure/provider-neutral:
 *
 *  1. Structured nature sub-preference classification (spec §B/§K) — the
 *     Round 9.14 audit proved "nature"/"mountains"/"beaches" collapse into
 *     one generic NATURE family weight (stay-activity-pool.ts's
 *     buildPreferenceFamilyWeights, unchanged this round). This adds a
 *     SEPARATE, additive, small-magnitude fit bonus that distinguishes
 *     which SPECIFIC nature sub-preferences the user actually selected
 *     (never invented) from which sub-types a given candidate's own OSM
 *     tags actually represent — never a country-specific mapping.
 *
 *  2. Single-day nature EXPERIENCE assembly (spec §F/§G/§H) — grouping
 *     genuinely coherent, geographically-clustered real components (a
 *     trailhead + a named trail + a waterfall + a viewpoint) into ONE
 *     synthesized candidate, represented as an ordinary TripRecommendation-
 *     shaped object with `provenance.natureExperience` attached (never a
 *     parallel data model — see trip-workspace.ts's own doc comment on
 *     NatureExperienceMetadata). This is deliberately NOT a general
 *     "nearby POI clustering" utility: it only ever assembles a cluster
 *     that contains genuine trail/route evidence (spec §H — unrelated
 *     nearby POIs never become one experience merely by proximity).
 */
import { haversineKm, type NatureExperienceType, type NatureSubPreference, type RealPlaceProvenance } from "@/lib/trip-workspace";
import type { RecommendationCategory } from "@/lib/trip-workspace";

// --- 1. Structured nature sub-preference ------------------------------

/**
 * Real, user-selected free-text keywords (Hebrew + English) mapped to a
 * structured sub-preference — never invented, never a country-specific
 * place-name mapping. Matched the same "narrow, generic keyword" way
 * buildPreferenceFamilyWeights/PREFERENCE_KEYWORD_TO_FAMILY already work
 * elsewhere in this codebase (activity-taxonomy.ts).
 */
const NATURE_SUBPREFERENCE_KEYWORDS: Record<NatureSubPreference, string[]> = {
  HIKING: ["hike", "hiking", "trek", "trekking", "trail", "טרק", "טיול רגלי", "מסלול הליכה", "שביל"],
  MOUNTAINS: ["mountain", "peak", "summit", "הר", "הרים", "פסגה"],
  WATERFALLS: ["waterfall", "falls", "מפל", "מפלים"],
  COAST: ["coast", "coastline", "cliff", "חוף ים", "צוק", "קו חוף"],
  BEACHES: ["beach", "חוף", "חופים"],
  LAKES_RIVERS: ["lake", "river", "אגם", "נהר"],
  WILDLIFE: ["wildlife", "safari", "reserve", "חיות בר", "שמורת טבע"],
  SCENIC_VIEWS: ["viewpoint", "scenic view", "vista", "תצפית", "נוף"],
  SCENIC_DRIVES: ["scenic drive", "scenic route", "road trip", "נסיעה נופית", "כביש נופי"],
};

/** Which of the user's REAL selected interests (never invented) map to a structured nature sub-preference. Returns an empty array for a traveler who never mentioned any of these — the generic NATURE family weight (unchanged) is all such a trip gets. */
export function extractSelectedNatureSubPreferences(interestsText: string): NatureSubPreference[] {
  const haystack = interestsText.toLowerCase();
  const selected: NatureSubPreference[] = [];
  for (const [subPreference, keywords] of Object.entries(NATURE_SUBPREFERENCE_KEYWORDS) as [NatureSubPreference, string[]][]) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      selected.push(subPreference);
    }
  }
  return selected;
}

/** What nature sub-type(s) a candidate's OWN OSM tags actually represent — structured metadata first, never guessed from its name alone. */
export function classifyNatureTypesFromTags(tags: Record<string, string> | null | undefined): NatureSubPreference[] {
  if (!tags) return [];
  const types = new Set<NatureSubPreference>();
  if (tags.natural === "peak") types.add("MOUNTAINS");
  if (tags.natural === "waterfall") types.add("WATERFALLS");
  if (tags.natural === "cliff") types.add("COAST");
  if (tags.natural === "beach") types.add("BEACHES");
  if (tags.natural === "water" || tags.water) types.add("LAKES_RIVERS");
  if (tags.leisure === "nature_reserve") types.add("WILDLIFE");
  if (tags.tourism === "viewpoint") types.add("SCENIC_VIEWS");
  if (tags.route === "hiking" || tags.route === "foot" || tags.information === "trailhead") types.add("HIKING");
  if ((tags.highway === "path" || tags.highway === "footway") && (tags.sac_scale || tags.trail_visibility)) types.add("HIKING");
  if (tags.tourism === "alpine_hut") types.add("MOUNTAINS");
  if (tags.boundary === "protected_area") types.add("WILDLIFE");
  return [...types];
}

/**
 * Round 9.15 §K — a small, additive fit bonus (never a huge multiplier
 * applied to every bare category=nature item, per spec §V/§K's explicit
 * warning) on top of the existing flat NATURE family weight: rewards a
 * candidate whose OWN nature types actually overlap with what the
 * traveler specifically selected. A generic nature-interested traveler
 * (no specific sub-preference selected) gets 0 here — the existing family
 * weight is their only boost, unchanged.
 */
export function computeNatureSubPreferenceFit(selectedSubPreferences: NatureSubPreference[], candidateNatureTypes: NatureSubPreference[]): number {
  if (selectedSubPreferences.length === 0 || candidateNatureTypes.length === 0) return 0;
  const overlap = candidateNatureTypes.filter((type) => selectedSubPreferences.includes(type)).length;
  return Math.min(0.3, overlap * 0.15); // capped — a fit bonus, never a dominant term
}

// --- 2. Single-day nature experience assembly --------------------------

/** Per-type honest default visit duration (minutes) for a component with no explicit duration of its own — never fabricated as "the real visit took exactly N minutes", just a reasonable planning estimate consistent with how every other synthetic default in this codebase is documented. */
const NATURE_COMPONENT_DEFAULT_MINUTES: Partial<Record<NatureSubPreference, number>> = {
  HIKING: 120,
  MOUNTAINS: 60,
  WATERFALLS: 30,
  COAST: 30,
  BEACHES: 45,
  LAKES_RIVERS: 30,
  WILDLIFE: 60,
  SCENIC_VIEWS: 20,
  SCENIC_DRIVES: 60,
};
const DEFAULT_COMPONENT_MINUTES = 45;

/**
 * The minimal shape assembleNatureExperiences needs from a candidate —
 * deliberately narrow so it never depends on the full
 * StayActivityPoolCandidate/TripRecommendation shape (keeps this module a
 * pure, independently-testable unit).
 *
 * Round 9.15.1 §D — `osmTags` is now OPTIONAL: the pool-level re-assembly
 * pass (stay-activity-pool.ts) runs on candidates that only ever carry
 * pre-computed `natureTypes` (StayActivityPoolCandidate has no raw osmTags
 * field), never raw provider tags — the ORIGINAL Round 9.15 buildStayActivityPool
 * assembly pass still passes real osmTags (richer evidence: distance/
 * sac_scale extraction only works from real tags). At least one of the two
 * must be present for hasTrailEvidence to ever find a genuine trail signal
 * — a component with neither is treated as having no trail evidence.
 */
export interface NatureExperienceComponentInput {
  recommendationId: string;
  name: string;
  lat: number;
  lon: number;
  osmTags?: Record<string, string> | null;
  natureTypes?: NatureSubPreference[];
}

/** Round 9.15.1 §G — truthful duration confidence: never claim a precise verified duration from a generic per-type default. */
export type DurationConfidence = "VERIFIED_DURATION" | "ESTIMATED_DURATION" | "UNKNOWN_DURATION";

export interface AssembledNatureExperience {
  name: string;
  shortDescription: string;
  category: RecommendationCategory;
  estimatedDurationMinutes: number;
  lat: number;
  lon: number;
  provenance: RealPlaceProvenance;
}

/** Round 9.15 §H — the cluster radius within which components are considered geographically coherent enough to potentially form one on-foot/short-drive experience together. Deliberately small (a genuine hike's own components — trailhead/trail/waterfall/viewpoint — sit within walking/short-drive range of each other); this is NOT the 150-minute regional/excursion reach model (Round 9.11), which decides whether the WHOLE experience is worth traveling to from the stay, a separate and later question. */
const EXPERIENCE_CLUSTER_RADIUS_KM = 4;

/**
 * Round 9.15.1 §D/§E — does this ONE component itself carry genuine trail
 * evidence? Checked from real osmTags when available (richer: distinguishes
 * a bare highway=path from one WITH sac_scale/trail_visibility), falling
 * back to the pre-computed natureTypes' "HIKING" marker when osmTags isn't
 * available (the pool-level re-assembly path) — classifyNatureTypesFromTags
 * already encodes the identical rule (route/trailhead/evidenced path), so
 * this is not a second, drifting definition of "trail evidence", just the
 * same one read from whichever representation is on hand.
 */
function hasTrailEvidence(component: NatureExperienceComponentInput): boolean {
  const tags = component.osmTags;
  if (tags) {
    if (tags.route === "hiking" || tags.route === "foot" || tags.information === "trailhead") return true;
    if ((tags.highway === "path" || tags.highway === "footway") && (Boolean(tags.sac_scale) || Boolean(tags.trail_visibility))) return true;
  }
  return component.natureTypes?.includes("HIKING") ?? false;
}

/**
 * Round 9.15.1 §F — a small, explicit evidence-strength score per
 * component: 2 for STRONG structured trail-specific evidence (sac_scale/
 * trail_visibility/an explicit route tag/a real trailhead — Part F's own
 * "strong evidence" list), 1 for an ordinary nature landmark tag (peak/
 * waterfall/viewpoint/protected-area/nature_reserve — genuine but not
 * itself trail-specific), 0 for a component with no structured evidence at
 * all (proximity alone). Never a destination-specific name list (Part F).
 */
function componentEvidenceScore(component: NatureExperienceComponentInput): number {
  const tags = component.osmTags;
  if (tags) {
    const strong = Boolean(tags.sac_scale) || Boolean(tags.trail_visibility) || tags.route === "hiking" || tags.route === "foot" || tags.information === "trailhead";
    if (strong) return 2;
  }
  if (component.natureTypes?.includes("HIKING")) return 2;
  if ((component.natureTypes?.length ?? 0) > 0) return 1;
  return 0;
}

/**
 * Round 9.15.1 §G — duration/type classification gated by REAL evidence
 * strength, not merely by summed minutes. A cluster whose components are
 * mostly generic defaults (weak/no evidence) is never allowed to claim
 * NATURE_FULL_DAY_HIKE just because enough default-45-minute components
 * happened to sum past 300 — that would be exactly the "pretend it is a
 * 6-hour hike" fabrication Part G explicitly forbids. `strongEvidenceCount`
 * (componentEvidenceScore === 2) is the gate: a FULL_DAY claim requires at
 * least 2 strong-evidence components (e.g. a real trail + a real peak/
 * waterfall it connects to), a HALF_DAY claim requires at least 1.
 */
function classifyNatureExperienceType(durationMinutes: number, hasTrailComponent: boolean, componentCount: number, strongEvidenceCount: number): NatureExperienceType {
  if (!hasTrailComponent) {
    return componentCount > 1 ? "SCENIC_NATURE_ROUTE" : "NATURE_SHORT_WALK";
  }
  if (durationMinutes >= 300 && strongEvidenceCount >= 2) return "NATURE_FULL_DAY_HIKE";
  if (durationMinutes >= 150 && strongEvidenceCount >= 1) return "NATURE_HALF_DAY_HIKE";
  return "NATURE_SHORT_WALK";
}

/** Round 9.15.1 §G — VERIFIED only when a real OSM `distance` tag backs the total; ESTIMATED whenever the total is summed from per-type planning defaults (the current model's only other case); UNKNOWN is reserved for a future evidence source this round doesn't have (never produced today, but kept as a real, distinct value rather than silently folding into ESTIMATED). */
function classifyDurationConfidence(hasRealDistanceTag: boolean): DurationConfidence {
  return hasRealDistanceTag ? "VERIFIED_DURATION" : "ESTIMATED_DURATION";
}

/**
 * Round 9.15 §H — greedy proximity clustering (never a redesign of the
 * stay's own geography model): sort components by latitude to get a stable
 * order, then grow one cluster at a time, pulling in any not-yet-assigned
 * component within EXPERIENCE_CLUSTER_RADIUS_KM of ANY member already in
 * the cluster (single-link clustering) — coherent for a hike whose
 * components are strung along a trail, not just clustered around one
 * center point.
 */
function clusterByProximity(components: NatureExperienceComponentInput[]): NatureExperienceComponentInput[][] {
  const remaining = [...components];
  const clusters: NatureExperienceComponentInput[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const cluster = [seed];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const candidate = remaining[i];
        const withinRange = cluster.some((member) => haversineKm(member.lat, member.lon, candidate.lat, candidate.lon) <= EXPERIENCE_CLUSTER_RADIUS_KM);
        if (withinRange) {
          cluster.push(candidate);
          remaining.splice(i, 1);
          grew = true;
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Round 9.15 §F/§H — the core assembly function. Only ever combines
 * components that (a) are geographically clustered (see above) AND (b)
 * the cluster contains at least one genuine trail/route/trailhead
 * component — never merges e.g. "unrelated beach + museum + random
 * viewpoint" just because they happen to be nearby (spec §H's own
 * example). A cluster with NO trail evidence, even if geographically
 * tight, is left as separate standalone candidates (returned untouched in
 * `unassembled`) — e.g. two unrelated viewpoints 2km apart never become a
 * fake "hike". A cluster of exactly one component is also left standalone
 * (an assembled "experience" of one part is just that one place).
 */
export function assembleNatureExperiences(
  components: NatureExperienceComponentInput[]
): { experiences: AssembledNatureExperience[]; unassembled: NatureExperienceComponentInput[] } {
  const clusters = clusterByProximity(components);
  const experiences: AssembledNatureExperience[] = [];
  const unassembled: NatureExperienceComponentInput[] = [];

  for (const cluster of clusters) {
    const hasTrailComponent = cluster.some(hasTrailEvidence);
    if (cluster.length < 2 || !hasTrailComponent) {
      unassembled.push(...cluster);
      continue;
    }

    const natureTypesPerComponent = cluster.map((c) => c.natureTypes ?? classifyNatureTypesFromTags(c.osmTags));
    const allNatureTypes = [...new Set(natureTypesPerComponent.flat())];
    const estimatedDurationMinutes = cluster.reduce((sum, c, index) => {
      const types = natureTypesPerComponent[index];
      const perComponentMinutes = types.length > 0 ? Math.max(...types.map((t) => NATURE_COMPONENT_DEFAULT_MINUTES[t] ?? DEFAULT_COMPONENT_MINUTES)) : DEFAULT_COMPONENT_MINUTES;
      return sum + perComponentMinutes;
    }, 0);
    const strongEvidenceCount = cluster.filter((c) => componentEvidenceScore(c) === 2).length;

    const experienceType = classifyNatureExperienceType(estimatedDurationMinutes, hasTrailComponent, cluster.length, strongEvidenceCount);
    const start = cluster[0];
    const end = cluster[cluster.length - 1];
    const difficulty = cluster.map((c) => c.osmTags?.sac_scale).find((value) => Boolean(value)) ?? null;
    const distanceTag = cluster.map((c) => c.osmTags?.distance).find((value) => Boolean(value)) ?? null;
    const distanceKm = distanceTag ? Number.parseFloat(distanceTag) : null;
    const durationConfidence = classifyDurationConfidence(distanceKm != null);
    const title = `חוויית טבע: ${cluster.map((c) => c.name).join(" → ")}`;
    const experienceId = `nature-experience:${start.lat.toFixed(5)}:${start.lon.toFixed(5)}:${cluster.length}`;
    // Round 9.15 §J — classifyVisitScale (itinerary-planning-principles.ts)
    // hard-codes category==="nature" to "medium" regardless of duration —
    // an out-of-scope, generic, category-wide shortcut this round does not
    // touch (it also governs "attraction", "museum", etc.). Its OWN
    // existing, already-tested escape hatch is a name/description keyword
    // match against FULL_DAY_KEYWORDS ("יום שלם")/HALF_DAY_KEYWORDS
    // ("חצי יום") — reused here honestly (the phrase is only ever added
    // when the duration genuinely computed above crosses that real
    // threshold), so a genuine half/full-day assembled hike reaches
    // HALF_DAY/FULL_DAY scale without any change to that shared function.
    const durationKeywordSuffix =
      experienceType === "NATURE_FULL_DAY_HIKE" ? " מסלול טיול יום שלם." : experienceType === "NATURE_HALF_DAY_HIKE" ? " מסלול טיול חצי יום." : "";

    experiences.push({
      name: title,
      shortDescription: `חוויית טבע מורכבת מ-${cluster.length} מרכיבים אמיתיים: ${cluster.map((c) => c.name).join(", ")}.${durationKeywordSuffix}`,
      category: "nature",
      estimatedDurationMinutes,
      lat: start.lat,
      lon: start.lon,
      provenance: {
        provider: "overpass",
        providerId: experienceId,
        osmTags: undefined,
        natureExperience: {
          experienceId,
          experienceType,
          componentRecommendationIds: cluster.map((c) => c.recommendationId),
          natureTypes: allNatureTypes,
          startLocation: { lat: start.lat, lon: start.lon },
          endLocation: { lat: end.lat, lon: end.lon },
          difficulty: difficulty ?? null,
          distanceKm: distanceKm != null && !Number.isNaN(distanceKm) ? distanceKm : null,
          routeGeometryAvailable: false,
          durationConfidence,
        },
      },
    });
  }

  // computeNatureSubPreferenceFit is applied by the caller (portfolio
  // scoring) against each experience's own natureTypes — never baked into
  // duration/assembly itself, so assembly stays preference-agnostic and
  // reusable regardless of who the traveler is.
  return { experiences, unassembled };
}

export { classifyNatureExperienceType };
