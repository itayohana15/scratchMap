// Pure, tiny, framework-free aggregation of several real per-request
// provider outcomes into one overall signal (spec §B2/§B3) — kept in its
// own client-safe module (no React Query, no server-only imports) so both
// the production wizard (client component) and the standalone QA harness
// can share exactly one aggregation rule instead of two drifting copies.

export type OverpassProviderStatus = "available" | "unavailable" | "partial" | null;

/**
 * `outcomes` is one entry per real request actually made (true = that
 * request succeeded, regardless of how many places it returned — spec
 * §B2's "zero results != provider failure"). An empty list (nothing was
 * ever queried, e.g. every category lacked a data source) is genuinely
 * unknown, not "unavailable" — returns null rather than guessing.
 */
export function aggregateOverpassStatus(outcomes: Array<boolean | null>): OverpassProviderStatus {
  const known = outcomes.filter((outcome): outcome is boolean => outcome != null);
  if (known.length === 0) return null;
  if (known.every(Boolean)) return "available";
  if (known.some(Boolean)) return "partial";
  return "unavailable";
}
