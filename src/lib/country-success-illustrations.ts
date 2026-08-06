export interface CountrySuccessIllustrationDefinition {
  countryCode: string;
  illustrationPath: string;
  alt: string;
  accentColor?: string;
  visualStyle?: string;
}

export interface ResolvedCountrySuccessIllustration
  extends CountrySuccessIllustrationDefinition {
  flagPath: string;
  isFallback: boolean;
}

const COUNTRY_SUCCESS_ILLUSTRATIONS: Record<
  string,
  Omit<CountrySuccessIllustrationDefinition, "countryCode">
> = {
  AU: {
    illustrationPath: "/images/country-success/au.jpg",
    alt: "אקוורל היסטורי של קנגורו אוסטרלי",
    accentColor: "#9a6b42",
    visualStyle: "אקוורל טבע",
  },
  BR: {
    illustrationPath: "/images/country-success/br.jpg",
    alt: "ציור מים של טוקאן צבעוני כסמל טבע דרום-אמריקאי",
    accentColor: "#0f766e",
    visualStyle: "איור טבע מסורתי",
  },
  CN: {
    illustrationPath: "/images/country-success/cn.jpg",
    alt: "איור היסטורי של החומה הגדולה בסין",
    accentColor: "#8f3b2c",
    visualStyle: "הדפס היסטורי",
  },
  EG: {
    illustrationPath: "/images/country-success/eg.jpg",
    alt: "אקוורל של הפירמידות במצרים על רקע מדברי",
    accentColor: "#c28a2d",
    visualStyle: "אקוורל מדברי",
  },
  FR: {
    illustrationPath: "/images/country-success/fr.jpg",
    alt: "ציור של מגדל אייפל והסן בפריז",
    accentColor: "#355c9a",
    visualStyle: "ציור פריזאי",
  },
  GB: {
    illustrationPath: "/images/country-success/gb.jpg",
    alt: "אקוורל ערפילי של ביג בן ולונדון",
    accentColor: "#5b6d91",
    visualStyle: "ווטרקול ערפילי",
  },
  GR: {
    illustrationPath: "/images/country-success/gr.jpg",
    alt: "ציור נופי של האקרופוליס בסגנון מים",
    accentColor: "#5c7ea4",
    visualStyle: "נוף ים-תיכוני",
  },
  IN: {
    illustrationPath: "/images/country-success/in.jpg",
    alt: "ציור מים של הטאג' מהאל ונוף הודי",
    accentColor: "#c67b2f",
    visualStyle: "אקוורל היסטורי",
  },
  IT: {
    illustrationPath: "/images/country-success/it.jpg",
    alt: "ציור מים של סמטה ותעלה בוונציה",
    accentColor: "#7d6a54",
    visualStyle: "ווטרקול ונציאני",
  },
  JP: {
    illustrationPath: "/images/country-success/jp.jpg",
    alt: "ציור מסורתי של הר פוג'י בסגנון יפני",
    accentColor: "#7a4d56",
    visualStyle: "ציור דיו מסורתי",
  },
};

const FALLBACK_ILLUSTRATION_PATH = "/images/country-success/generic.jpg";
const DEFAULT_ACCENT_COLOR = "#5c7c67";
const loggedMissingCountries = new Set<string>();

export function getCountrySuccessIllustration(
  countryCode: string,
  countryName: string
): ResolvedCountrySuccessIllustration {
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  const dedicatedIllustration = COUNTRY_SUCCESS_ILLUSTRATIONS[normalizedCountryCode];

  if (!dedicatedIllustration) {
    if (
      process.env.NODE_ENV === "development" &&
      typeof window !== "undefined" &&
      !loggedMissingCountries.has(normalizedCountryCode)
    ) {
      loggedMissingCountries.add(normalizedCountryCode);
      console.info(
        `[country-success] Missing dedicated artwork for ${normalizedCountryCode} (${countryName})`
      );
    }

    return {
      countryCode: normalizedCountryCode,
      illustrationPath: FALLBACK_ILLUSTRATION_PATH,
      alt: `ציור מסע כללי עבור ${countryName}`,
      accentColor: DEFAULT_ACCENT_COLOR,
      visualStyle: "אקוורל כללי",
      flagPath: `/flags/${normalizedCountryCode.toLowerCase() || "xx"}.png`,
      isFallback: true,
    };
  }

  return {
    countryCode: normalizedCountryCode,
    ...dedicatedIllustration,
    accentColor: dedicatedIllustration.accentColor ?? DEFAULT_ACCENT_COLOR,
    flagPath: `/flags/${normalizedCountryCode.toLowerCase()}.png`,
    isFallback: false,
  };
}
