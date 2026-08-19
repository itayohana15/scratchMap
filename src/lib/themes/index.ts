import { alpine } from "@/lib/themes/alpine";
import { arctic } from "@/lib/themes/arctic";
import { aurora } from "@/lib/themes/aurora";
import { autumnTrail } from "@/lib/themes/autumnTrail";
import { THEME_BACKGROUNDS } from "@/lib/themes/backgrounds";
import { cherryBlossomNight } from "@/lib/themes/cherryBlossomNight";
import { coffeeHouse } from "@/lib/themes/coffeeHouse";
import { cyberNeon } from "@/lib/themes/cyberNeon";
import { desertSand } from "@/lib/themes/desertSand";
import { emeraldNight } from "@/lib/themes/emeraldNight";
import { forestExplorer } from "@/lib/themes/forestExplorer";
import { japaneseInk } from "@/lib/themes/japaneseInk";
import { matchaGarden } from "@/lib/themes/matchaGarden";
import { mediterranean } from "@/lib/themes/mediterranean";
import { midnightGold } from "@/lib/themes/midnightGold";
import { monochrome } from "@/lib/themes/monochrome";
import { nordicFrost } from "@/lib/themes/nordicFrost";
import { northernLights } from "@/lib/themes/northernLights";
import { oceanBreeze } from "@/lib/themes/oceanBreeze";
import { royalPurple } from "@/lib/themes/royalPurple";
import { sakura } from "@/lib/themes/sakura";
import { solarizedTraveler } from "@/lib/themes/solarizedTraveler";
import { sunsetJourney } from "@/lib/themes/sunsetJourney";
import { terracotta } from "@/lib/themes/terracotta";
import { tropicalLagoon } from "@/lib/themes/tropicalLagoon";
import { vintageExplorer } from "@/lib/themes/vintageExplorer";

import type {
  ResolvedThemeDefinition,
  ThemeBackgroundDefinition,
  ThemeDefinition as ThemeSeedDefinition,
} from "@/lib/themes/types";

export type {
  ResolvedThemeDefinition as ThemeDefinition,
  ThemeBackgroundDefinition,
  ThemeSwatches,
} from "@/lib/themes/types";

// New themes are added here — just create a themes/yourTheme.ts file (see
// any existing one for the shape) and list it below. Nothing else needs to
// change: the gallery, persistence, and CSS application all read from this
// single registry. To group a new theme in the Settings selector, also add
// it to THEME_CATEGORIES (and optionally THEME_STYLE_TAGS) in
// src/lib/themes/catalog.ts.
const THEME_SEEDS = [
  // Original 10 (unchanged)
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
  // Added — light
  nordicFrost,
  japaneseInk,
  mediterranean,
  solarizedTraveler,
  monochrome,
  // Added — dark
  cherryBlossomNight,
  northernLights,
  // Added — nature
  matchaGarden,
  tropicalLagoon,
  alpine,
  autumnTrail,
  // Added — warm / travel
  sunsetJourney,
  terracotta,
  vintageExplorer,
  coffeeHouse,
] as const satisfies readonly ThemeSeedDefinition[];

type ThemeSeedId = (typeof THEME_SEEDS)[number]["id"];

// Enforces that every registered theme has a matching background definition.
const themeBackgrounds: Record<ThemeSeedId, ThemeBackgroundDefinition> = THEME_BACKGROUNDS;

export const THEMES = THEME_SEEDS.map((theme) => ({
  ...theme,
  background: themeBackgrounds[theme.id],
})) as readonly ResolvedThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME_ID: ThemeId = "arctic-light";

export function getThemeById(id: string) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME_ID)!;
}

export const THEME_IDS: ThemeId[] = THEMES.map((theme) => theme.id);
