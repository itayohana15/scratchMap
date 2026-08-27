import holidayData from "@/lib/facts/jewish-holidays-data.json";

/**
 * Jewish/Israeli holiday markers for the trip calendar (spec items 26-34).
 *
 * Dates come from a static, precomputed data file
 * (jewish-holidays-data.json), generated once by
 * scripts/generate-jewish-holidays.mjs using @hebcal/core — the same
 * astronomically-accurate engine behind hebcal.com — never hand-typed. This
 * matches the "authoritative/current source, don't invent dates" bar the
 * spec itself sets, while avoiding a runtime dependency on @hebcal/core:
 * it's an ESM-only package, and this project's test suite compiles a subset
 * of src/lib to CommonJS for headless `node --test` runs, where require()-ing
 * an ESM-only package throws. Precomputing sidesteps that entirely — the
 * same "static facts data" pattern this project already uses for
 * country-facts-data.json. Re-run the generator script to extend the year
 * range or refresh after a library update.
 *
 * Israeli school-vacation periods (spec item 27) are deliberately NOT
 * included here: no reliable, currently-maintained dataset for those is
 * available in this project, and inventing them would violate the same
 * principle this module exists to uphold.
 */
export type HolidayCategory = "jewish_holiday" | "israeli_public_holiday";

export interface HolidayInfo {
  date: string; // YYYY-MM-DD
  nameHe: string;
  categories: HolidayCategory[];
}

const ALL_HOLIDAYS = holidayData as HolidayInfo[];

/** All matched holidays for one Gregorian year. */
export function getHolidaysForYear(year: number): HolidayInfo[] {
  const prefix = String(year);
  return ALL_HOLIDAYS.filter((holiday) => holiday.date.startsWith(prefix));
}

/** Holidays across every year touched by the given date range (inclusive), for a calendar that may span a year boundary. */
export function getHolidaysForYearRange(startYear: number, endYear: number): HolidayInfo[] {
  return ALL_HOLIDAYS.filter((holiday) => {
    const year = Number(holiday.date.slice(0, 4));
    return year >= startYear && year <= endYear;
  });
}

export function findHolidayForDate(holidays: HolidayInfo[], isoDate: string): HolidayInfo | null {
  return holidays.find((holiday) => holiday.date === isoDate) ?? null;
}

function addOneDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * A single, compact planning warning for one date (spec item 34) — never a
 * hard block, just a heads-up surfaced in the wizard. Fires either when the
 * date itself is a holiday, or when it's the eve of one (the more common
 * real case for outbound flights, e.g. "ערב ראש השנה").
 */
export function getHolidayTravelWarning(isoDate: string): string | null {
  if (!isoDate) return null;

  const onDate = findHolidayForDate(ALL_HOLIDAYS, isoDate);
  if (onDate) {
    return `⚠ ${onDate.nameHe} — ייתכנו עומסים בנתב"ג ובתחבורה, ומחירי טיסות גבוהים יותר בתאריך זה.`;
  }

  const eveOf = findHolidayForDate(ALL_HOLIDAYS, addOneDay(isoDate));
  if (eveOf) {
    return `⚠ ערב ${eveOf.nameHe} — ייתכנו עומסים בנתב"ג ובתחבורה לקראת החג.`;
  }

  return null;
}

/** Holidays that fall anywhere inside a trip's date range — for threading holiday context into the AI planning prompt (never a hard block on those dates). */
export function getHolidaysOverlappingRange(startDate: string, endDate: string): HolidayInfo[] {
  if (!startDate || !endDate) return [];
  return ALL_HOLIDAYS.filter((holiday) => holiday.date >= startDate && holiday.date <= endDate);
}

/**
 * One line of advisory (never mandatory) planning context for the AI prompt
 * when the trip overlaps Israeli/Jewish holidays — e.g. flagged closures on
 * a foreign country's Israeli-run tour operators, or extra travel demand.
 * Kept as plain informational context, never phrased as a hard constraint.
 */
export function describeHolidayContext(startDate: string, endDate: string): string {
  const holidays = getHolidaysOverlappingRange(startDate, endDate);
  if (holidays.length === 0) return "";
  const names = holidays.map((holiday) => `${holiday.nameHe} (${holiday.date})`).join(", ");
  return `Note for context only, not a hard constraint: this trip overlaps the following Israeli/Jewish calendar dates, which may mean higher local travel demand, different opening hours for Israeli-run services, or a more festive/crowded atmosphere on those specific days: ${names}.`;
}
