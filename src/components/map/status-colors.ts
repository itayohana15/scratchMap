import type { Status } from "@/lib/supabase/types";

// Single source of truth for status coloring — mirrors the --visited /
// --planned / --not-visited custom properties in globals.css (same
// Tailwind green-500/blue-500/gray-400 and dark-mode 400/600 pairs) so the
// map fill, legend, and any status badges elsewhere always agree.
export const STATUS_COLORS: Record<Status, { light: string; dark: string }> = {
  visited: { light: "#22c55e", dark: "#4ade80" },
  planned: { light: "#3b82f6", dark: "#60a5fa" },
  not_visited: { light: "#9ca3af", dark: "#52525c" },
};

export const STATUS_LABELS: Record<Status, string> = {
  visited: "ביקרתי",
  planned: "מתוכנן",
  not_visited: "לא ביקרתי",
};

export function statusColor(status: Status, isDark: boolean) {
  return isDark ? STATUS_COLORS[status].dark : STATUS_COLORS[status].light;
}
