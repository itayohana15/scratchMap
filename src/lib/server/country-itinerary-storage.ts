const MISSING_STORAGE_MESSAGE =
  "אחסון המסלולים עדיין לא הוגדר במסד הנתונים. צריך להחיל את סכימת itinerary לפני שאפשר לשמור או לטעון מסלולים.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasMissingTableMessage(error: Record<string, unknown>, tableName: string) {
  const message = typeof error.message === "string" ? error.message : "";
  return message.includes("Could not find the table") && message.includes(tableName);
}

export function isMissingCountryItineraryStorageError(error: unknown) {
  if (!isRecord(error)) return false;
  return (
    error.code === "PGRST205" &&
    (hasMissingTableMessage(error, "public.country_itineraries") ||
      hasMissingTableMessage(error, "public.country_itinerary_versions"))
  );
}

export function toCountryItineraryStorageError(error: unknown) {
  if (isMissingCountryItineraryStorageError(error)) {
    return new Error(MISSING_STORAGE_MESSAGE);
  }

  return error instanceof Error ? error : new Error("Itinerary storage request failed");
}
