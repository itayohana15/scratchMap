import { createDefaultWorkspace, type TripBooking, type TripPreferences } from "@/lib/trip-workspace";

export interface TripCreationDraft {
  preferences: TripPreferences;
  bookings: TripBooking[];
  userProvidedTitle: string;
}

export function createEmptyTripCreationDraft(
  countryName: string,
  derivedDefaults: { derivedPace: TripPreferences["tripPace"]; derivedInterests: string }
): TripCreationDraft {
  const base = createDefaultWorkspace(countryName).preferences;
  return {
    preferences: {
      ...base,
      tripPace: derivedDefaults.derivedPace,
      interests: derivedDefaults.derivedInterests,
    },
    bookings: [],
    userProvidedTitle: "",
  };
}

export function isTripCreationDraftEmpty(draft: TripCreationDraft): boolean {
  const { preferences, bookings, userProvidedTitle } = draft;
  return (
    !preferences.startDate &&
    !preferences.endDate &&
    preferences.budget == null &&
    !userProvidedTitle.trim() &&
    !preferences.flights?.outbound &&
    !preferences.flights?.return &&
    !preferences.mustVisitPlaces.trim() &&
    !preferences.placesToAvoid.trim() &&
    !preferences.dietaryPreferences.trim() &&
    !preferences.accessibilityNeeds.trim() &&
    !preferences.safetyConstraints.trim() &&
    bookings.length === 0
  );
}

export const WIZARD_STEP_COUNT = 8;

export type WizardPhase = "wizard" | "generating" | "success" | "error" | "budgetWarning";

/**
 * Final deterministic gate before the POST (spec Part M) — dates/flight
 * times/booking fields are all checked here so a request that's obviously
 * invalid never reaches AI generation. Per-step validation (e.g.
 * validateStepBasics) already blocks most of this earlier; this is the
 * defensive re-check right before submit.
 */
export function validateDraftForSubmit(draft: TripCreationDraft): string | null {
  const { preferences, bookings } = draft;
  if (!preferences.startDate || !preferences.endDate) return "יש להשלים תאריכי התחלה וסיום.";
  if (preferences.endDate < preferences.startDate) return "תאריך הסיום לא יכול להיות לפני תאריך ההתחלה.";
  if (!Number.isFinite(preferences.travelers) || preferences.travelers < 1) {
    return "מספר הנוסעים חייב להיות לפחות 1.";
  }
  if (preferences.budget == null || !Number.isFinite(preferences.budget) || preferences.budget <= 0) {
    return "יש להזין תקציב כולל תקין.";
  }

  const outbound = preferences.flights?.outbound;
  const returnLeg = preferences.flights?.return;
  if (outbound?.arrivalDate && returnLeg?.departureDate && returnLeg.departureDate < outbound.arrivalDate) {
    return "תאריך הטיסה חזרה לא יכול להיות לפני תאריך הנחיתה בהלוך.";
  }

  for (const booking of bookings) {
    if (!booking.title.trim() && !booking.location.trim()) {
      return "כל הזמנה קבועה צריכה לפחות שם או מקום.";
    }
  }

  return null;
}
