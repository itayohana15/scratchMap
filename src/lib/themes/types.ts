export interface ThemeSwatches {
  background: string;
  card: string;
  primary: string;
  secondary: string;
  accent: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  isDark: boolean;
  swatches: ThemeSwatches;
}
