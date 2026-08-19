import type { ThemeDefinition } from "@/lib/themes/types";

export const monochrome: ThemeDefinition = {
  id: "monochrome",
  name: "Monochrome",
  description: "לבן, אפור וגרפיט — ממשק שחור-לבן נקי ואדריכלי, מדויק ומאופק.",
  isDark: false,
  swatches: {
    background: "#ffffff",
    card: "#fbfbfc",
    primary: "#2b2d31",
    secondary: "#f0f1f2",
    accent: "#e7e8ea",
    tertiary: "#6b6e73",
    quaternary: "#17181a",
  },
};
