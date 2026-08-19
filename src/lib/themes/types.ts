export interface ThemeSwatches {
  background: string;
  card: string;
  primary: string;
  secondary: string;
  accent: string;
  // Optional extra palette dots for themes with more than 3 distinct accent
  // colors worth previewing in the theme card (existing themes leave these
  // unset and keep showing 3 dots as before).
  tertiary?: string;
  quaternary?: string;
}

export interface ThemeBackgroundDefinition {
  image: string;
  position: string;
  mobilePosition?: string;
  size: string;
  mobileSize?: string;
  repeat: string;
  opacity: number;
  overlay: string;
  overlayOpacity?: number;
  attachment?: "scroll" | "fixed" | "local";
  previewPosition?: string;
  previewSize?: string;
  previewOpacity?: number;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  isDark: boolean;
  swatches: ThemeSwatches;
  background?: ThemeBackgroundDefinition;
}

export interface ResolvedThemeDefinition extends Omit<ThemeDefinition, "background"> {
  background: ThemeBackgroundDefinition;
}
