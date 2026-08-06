import { arctic } from "@/lib/themes/arctic";
import { aurora } from "@/lib/themes/aurora";
import { cyberNeon } from "@/lib/themes/cyberNeon";
import { desertSand } from "@/lib/themes/desertSand";
import { emeraldNight } from "@/lib/themes/emeraldNight";
import { forestExplorer } from "@/lib/themes/forestExplorer";
import { midnightGold } from "@/lib/themes/midnightGold";
import { oceanBreeze } from "@/lib/themes/oceanBreeze";
import { royalPurple } from "@/lib/themes/royalPurple";
import { sakura } from "@/lib/themes/sakura";

export type { ThemeDefinition, ThemeSwatches } from "@/lib/themes/types";

// New themes are added here — just create a themes/yourTheme.ts file (see
// any existing one for the shape) and list it below. Nothing else needs to
// change: the gallery, persistence, and CSS application all read from this
// single registry.
export const THEMES = [
  arctic,
  midnightGold,
  oceanBreeze,
  forestExplorer,
  sakura,
  cyberNeon,
  royalPurple,
  desertSand,
  emeraldNight,
  aurora,
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME_ID: ThemeId = "arctic-light";

export function getThemeById(id: string) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME_ID)!;
}

export const THEME_IDS: ThemeId[] = THEMES.map((theme) => theme.id);
