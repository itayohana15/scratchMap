import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { he } from "date-fns/locale";

export function formatDate(value: string | null | undefined, pattern = "d בMMM yyyy") {
  if (!value) return null;
  return format(parseISO(value), pattern, { locale: he });
}

export function formatDateRange(start: string | null | undefined, end: string | null | undefined) {
  if (!start && !end) return null;
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  return formatDate(start ?? end);
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
