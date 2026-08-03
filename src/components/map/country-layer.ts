import type { ExpressionSpecification } from "maplibre-gl";

import { STATUS_COLORS } from "@/components/map/status-colors";
import type { Status } from "@/lib/supabase/types";

export function countryFillColorExpression(isDark: boolean): ExpressionSpecification {
  const colorFor = (status: Status) =>
    isDark ? STATUS_COLORS[status].dark : STATUS_COLORS[status].light;

  return [
    "match",
    ["feature-state", "status"],
    "visited",
    colorFor("visited"),
    "planned",
    colorFor("planned"),
    colorFor("not_visited"),
  ];
}

export const OCEAN_COLOR = { light: "#dbeafe", dark: "#0a1120" };
export const COUNTRY_BORDER_COLOR = { light: "#ffffff", dark: "#171717" };
export const COUNTRY_HOVER_BORDER_COLOR = { light: "#1e293b", dark: "#e5e5e5" };
