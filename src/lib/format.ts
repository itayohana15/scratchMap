import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { he } from "date-fns/locale";

function formatPartialMonthYear(partialDate: string | null | undefined) {
  if (!partialDate) return null;
  const [year, month] = partialDate.split("-").map(Number);
  if (!year || !month) return null;
  return format(new Date(year, month - 1, 1), "MMMM yyyy", { locale: he });
}

export function formatDate(value: string | null | undefined, pattern = "d בMMM yyyy") {
  if (!value) return null;
  return format(parseISO(value), pattern, { locale: he });
}

export function formatDateRange(start: string | null | undefined, end: string | null | undefined) {
  if (!start && !end) return null;
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  return formatDate(start ?? end);
}

/**
 * Compact, human trip-date formatting — the single source of truth for
 * every trip card/title/popup that shows a date range. Never repeats the
 * month/year twice, never shows a raw ISO string, and never invents a day
 * for a partial (month/year-only) historical date.
 *
 * - Same month + year:  "5-27 באוקטובר 2026" (single day: "5 באוקטובר 2026")
 * - Different month, same year: "5.6-27.7 2026"
 * - Different years: "1.12.26-25.1.27"
 * - Partial (YYYY-MM) only: "ספטמבר 2022"
 * - Nothing known: "ללא תאריכים"
 */
export function formatTripDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
  partialDate?: string | null
) {
  if (!start && !end) {
    const partialMonthYear = formatPartialMonthYear(partialDate);
    if (partialMonthYear) return partialMonthYear;
    return "ללא תאריכים";
  }

  if (!start || !end) {
    return formatDate(start ?? end) ?? "ללא תאריכים";
  }

  const startDate = parseISO(start);
  const endDate = parseISO(end);
  const startDay = startDate.getDate();
  const endDay = endDate.getDate();
  const startMonth = startDate.getMonth() + 1;
  const endMonth = endDate.getMonth() + 1;
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();

  if (startYear !== endYear) {
    const startYY = String(startYear).slice(-2);
    const endYY = String(endYear).slice(-2);
    return `${startDay}.${startMonth}.${startYY}-${endDay}.${endMonth}.${endYY}`;
  }

  if (startMonth !== endMonth) {
    return `${startDay}.${startMonth}-${endDay}.${endMonth} ${startYear}`;
  }

  const monthName = format(startDate, "MMMM", { locale: he });
  if (startDay === endDay) {
    return `${startDay} ב${monthName} ${startYear}`;
  }
  return `${startDay}-${endDay} ב${monthName} ${startYear}`;
}

export function formatTripDateRangeExpanded(
  start: string | null | undefined,
  end: string | null | undefined,
  partialDate?: string | null
) {
  if (!start && !end) {
    return formatPartialMonthYear(partialDate) ?? "ללא תאריכים";
  }

  if (!start || !end) {
    return formatDate(start ?? end) ?? "ללא תאריכים";
  }

  const startDate = parseISO(start);
  const endDate = parseISO(end);
  const startDay = startDate.getDate();
  const endDay = endDate.getDate();
  const startMonth = startDate.getMonth();
  const endMonth = endDate.getMonth();
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();

  if (startYear !== endYear) {
    return `${format(startDate, "d בMMM yyyy", { locale: he })} - ${format(endDate, "d בMMM yyyy", { locale: he })}`;
  }

  if (startMonth !== endMonth) {
    return `${format(startDate, "d בMMM", { locale: he })} - ${format(endDate, "d בMMM yyyy", { locale: he })}`;
  }

  const monthName = format(startDate, "MMM", { locale: he });
  if (startDay === endDay) {
    return `${startDay} ב${monthName} ${startYear}`;
  }
  return `${startDay}-${endDay} ב${monthName} ${startYear}`;
}

export function formatCurrency(value: number | null | undefined, currency = "ILS") {
  if (value == null) return "—";
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function tripDurationDays(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  return differenceInCalendarDays(parseISO(end), parseISO(start)) + 1;
}

export function formatRating(value: number | null | undefined) {
  if (value == null) return "—";
  return value.toFixed(1);
}

/** Elapsed duration display (spec item 23) — MM:SS under an hour, HH:MM:SS from an hour on. Never negative. */
export function formatElapsedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
