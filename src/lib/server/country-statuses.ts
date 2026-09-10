import type { SupabaseClient } from "@supabase/supabase-js";

import { deriveItineraryStatus, normalizeItineraryStatus } from "@/lib/itineraries";
import { getDestinationDateString } from "@/lib/live-trip-time";
import type { Database } from "@/lib/supabase/types";
import type { Status } from "@/lib/supabase/types";
import { deriveCountryTravelStatus } from "@/lib/travel-passport";

type DbClient = SupabaseClient<Database>;

export interface EffectiveCountryStatus {
  id: string;
  name: string;
  iso_a2: string;
  iso_a3: string | null;
  /** The raw, manually-set `countries.status` column — kept only as a fallback for a country with no trips. */
  status: Status;
  /** SERVER-authoritative country travel status, derived from persisted trips (spec "MAP STATUS MUST BE SERVER AUTHORITATIVE"). This is what every UI surface renders. */
  effectiveStatus: Status;
  /** Whether this country has ANY persisted (non-deleted) trip at all — drives whether the manual-status dropdown is even offered. */
  hasTrips: boolean;
}

/**
 * Spec "PART B — MAP STATUS MUST BE SERVER AUTHORITATIVE" — the ONE place
 * the effective country travel status is computed, on the server, from
 * persisted DB data:
 *
 *   countries + country_itineraries  ->  effectiveStatus per ISO A2
 *
 * The React client only renders `effectiveStatus`; it never re-derives the
 * business rule from trips. The rule itself is the unchanged, already
 * unit-tested `deriveCountryTravelStatus` from travel-passport.ts
 * (VISITED if any trip has started — startDate <= destination-local today,
 * or already completed/active; PLANNED if a future-only trip exists;
 * NOT_VISITED otherwise; precedence VISITED > PLANNED > NOT_VISITED).
 *
 * The manually-set `countries.status` column survives ONLY as the fallback
 * for a country that has no trip rows at all — the legitimate "I've been
 * here, no trip record" case. A country with trips always uses the
 * trip-derived value; there is never a second competing authoritative
 * state.
 */
export async function loadEffectiveCountryStatuses(
  supabase: DbClient,
  now: Date = new Date()
): Promise<EffectiveCountryStatus[]> {
  const [{ data: countryRows, error: countriesError }, { data: itineraryRows, error: itinerariesError }] = await Promise.all([
    supabase.from("countries").select("id, name, iso_a2, iso_a3, status").order("name"),
    supabase
      .from("country_itineraries")
      .select("iso_a2, start_date, end_date, status, archived")
      .is("deleted_at", null),
  ]);
  if (countriesError) throw countriesError;
  if (itinerariesError) throw itinerariesError;

  // Group trips by canonical ISO A2 (never by display name — Hebrew and
  // English labels for the same country must resolve identically).
  const hasStartedByIso = new Map<string, boolean[]>();
  for (const row of itineraryRows ?? []) {
    const iso = (row.iso_a2 ?? "").toUpperCase();
    if (!iso) continue;
    const derived = deriveItineraryStatus(
      row.start_date,
      row.end_date,
      row.archived ?? false,
      normalizeItineraryStatus(row.status ?? "draft"),
      iso,
      now
    );
    const today = getDestinationDateString(iso, now);
    const hasStarted =
      derived === "completed" ||
      derived === "active" ||
      Boolean(row.start_date && row.start_date <= today);
    const existing = hasStartedByIso.get(iso);
    if (existing) existing.push(hasStarted);
    else hasStartedByIso.set(iso, [hasStarted]);
  }

  return (countryRows ?? []).map((country) => {
    const iso = country.iso_a2.toUpperCase();
    const tripStartedFlags = hasStartedByIso.get(iso);
    const hasTrips = tripStartedFlags != null && tripStartedFlags.length > 0;
    const effectiveStatus: Status = hasTrips
      ? deriveCountryTravelStatus(tripStartedFlags.map((hasStarted) => ({ hasStarted })))
      : country.status;
    return {
      id: country.id,
      name: country.name,
      iso_a2: country.iso_a2,
      iso_a3: country.iso_a3,
      status: country.status,
      effectiveStatus,
      hasTrips,
    };
  });
}
