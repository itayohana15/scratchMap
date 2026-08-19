import type { ThemeId } from "@/lib/themes";

// Presentation-only metadata for the Settings theme gallery (section
// grouping + filter chips). Kept separate from the theme definitions
// themselves so the original 10 theme files never need to change — this
// file is the single place that classifies every theme (old and new) for
// the selector UI.
export type ThemeCategory = "light" | "dark" | "nature" | "warm";
export type ThemeStyleTag = "colorful" | "minimal";

export const THEME_CATEGORIES: Record<ThemeId, ThemeCategory> = {
  // Original 10
  "arctic-light": "light",
  "ocean-breeze": "light",
  sakura: "light",
  "desert-sand": "light",
  "midnight-gold": "dark",
  "royal-purple": "dark",
  "cyber-neon": "dark",
  aurora: "dark",
  "emerald-night": "dark",
  "forest-explorer": "nature",
  // Added
  "nordic-frost": "light",
  "japanese-ink": "light",
  mediterranean: "light",
  "solarized-traveler": "light",
  monochrome: "light",
  "cherry-blossom-night": "dark",
  "northern-lights": "dark",
  "matcha-garden": "nature",
  "tropical-lagoon": "nature",
  alpine: "nature",
  "autumn-trail": "nature",
  "sunset-journey": "warm",
  terracotta: "warm",
  "vintage-explorer": "warm",
  "coffee-house": "warm",
};

export const CATEGORY_LABELS: Record<ThemeCategory, string> = {
  light: "בהיר",
  dark: "כהה",
  nature: "טבע",
  warm: "חם / טיולים",
};

export const CATEGORY_ORDER: ThemeCategory[] = ["light", "dark", "nature", "warm"];

// Only themes with a clearly vibrant or clearly restrained identity carry a
// style tag; most themes sit in between and match neither filter.
export const THEME_STYLE_TAGS: Partial<Record<ThemeId, ThemeStyleTag[]>> = {
  "cyber-neon": ["colorful"],
  "royal-purple": ["colorful"],
  aurora: ["colorful"],
  "northern-lights": ["colorful"],
  "cherry-blossom-night": ["colorful"],
  sakura: ["colorful"],
  "emerald-night": ["colorful"],
  "sunset-journey": ["colorful"],
  "tropical-lagoon": ["colorful"],
  mediterranean: ["colorful"],
  "arctic-light": ["minimal"],
  "nordic-frost": ["minimal"],
  "japanese-ink": ["minimal"],
  monochrome: ["minimal"],
  "solarized-traveler": ["minimal"],
  alpine: ["minimal"],
};

export type ThemeFilterId = "all" | "light" | "dark" | "nature" | "colorful" | "minimal";

export const THEME_FILTERS: { id: ThemeFilterId; label: string }[] = [
  { id: "all", label: "הכל" },
  { id: "light", label: "בהיר" },
  { id: "dark", label: "כהה" },
  { id: "nature", label: "טבע" },
  { id: "colorful", label: "צבעוני" },
  { id: "minimal", label: "מינימליסטי" },
];
