"use client";

import { ArrowRight, Bot, CalendarClock, Star } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { STATUS_LABELS } from "@/components/map/status-colors";
import { CountryAiRecommendations } from "@/components/shared/country-ai-recommendations";
import { CountryBanner } from "@/components/shared/country-banner";
import { StatusSelect } from "@/components/shared/status-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTripDateRange } from "@/lib/format";
import { useCitiesByCountry } from "@/lib/queries/cities";
import { useCountryByIso, useMapCountryStatuses, useUpsertCountry } from "@/lib/queries/countries";
import { useTripHubTrips } from "@/lib/queries/trip-hub";
import type { Status } from "@/lib/supabase/types";

interface CountryDetailPanelProps {
  iso: string | null;
  displayName: string;
  iso3: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CountryDetailPanel({
  iso,
  displayName,
  iso3,
  open,
  onOpenChange,
}: CountryDetailPanelProps) {
  const { data: country, isLoading } = useCountryByIso(iso ?? undefined);
  const { data: cities } = useCitiesByCountry(country?.id);
  const { data: allTrips = [] } = useTripHubTrips();
  const { data: mapCountryStatuses } = useMapCountryStatuses();
  const upsertCountry = useUpsertCountry();
  const [pendingStatus, setPendingStatus] = useState<Status>("planned");

  const countryTrips = useMemo(
    () => allTrips.filter((trip) => trip.isoA2.toUpperCase() === (iso ?? "").toUpperCase()),
    [allTrips, iso]
  );
  const completedCountryTrips = countryTrips.filter((trip) => trip.status === "completed");
  const upcomingCountryTrip = countryTrips.find((trip) => trip.status === "upcoming");
  const visitYears = [...new Set(completedCountryTrips.map((trip) => trip.year))].sort();
  // Spec "PART B — MAP STATUS MUST BE SERVER AUTHORITATIVE" — the badge
  // reads the SERVER-computed effectiveStatus (same source the map fill
  // and sidebar use). The manual dropdown is only offered for a country
  // the server reports has no trips at all (`hasTrips === false`), where
  // the stored `countries.status` column is the legitimate fallback.
  const serverCountryStatus = useMemo(
    () => mapCountryStatuses?.find((entry) => entry.iso_a2.toUpperCase() === (iso ?? "").toUpperCase()),
    [mapCountryStatuses, iso]
  );
  const effectiveStatus: Status | undefined = serverCountryStatus?.effectiveStatus ?? country?.status;
  const hasCountryTrips = serverCountryStatus?.hasTrips ?? countryTrips.length > 0;

  async function handleAddCountry(status: Status) {
    if (!iso) return;
    setPendingStatus(status);
    try {
      await upsertCountry.mutateAsync({ name: displayName, iso_a2: iso.toUpperCase(), iso_a3: iso3, status });
      toast.success(`${displayName} נוספה לרשימה שלך`);
    } catch {
      toast.error(`הוספת ${displayName} נכשלה`);
    }
  }

  async function handleStatusChange(status: Status) {
    if (!country) return;
    try {
      await upsertCountry.mutateAsync({ id: country.id, status });
      toast.success("הסטטוס עודכן");
    } catch {
      toast.error("עדכון הסטטוס נכשל");
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {iso && (
          <>
            <CountryBanner isoA2={iso} countryName={country?.name ?? displayName} className="h-44 shrink-0" />

            <SheetHeader className="pt-0">
              <SheetTitle className="sr-only">{country?.name ?? displayName}</SheetTitle>
              {country && effectiveStatus && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="secondary">{STATUS_LABELS[effectiveStatus]}</Badge>
                  {country.rating != null && (
                    <span className="flex items-center gap-1">
                      <Star className="size-3.5 fill-current text-amber-500" />
                      {country.rating.toFixed(1)}
                    </span>
                  )}
                </div>
              )}
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4">
              {countryTrips.length > 0 ? (
                <section className="rounded-2xl border border-border/60 bg-card/60 p-3">
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                    <CalendarClock className="size-3.5 text-primary" />
                    הטיולים שלי למדינה זו
                  </h3>
                  {completedCountryTrips.length > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {completedCountryTrips.length} ביקורים · {visitYears.join(" · ")}
                    </p>
                  ) : null}
                  {upcomingCountryTrip ? (
                    <p className="mt-1 text-sm text-primary">
                      טיול קרוב:{" "}
                      <bdi dir="ltr">
                        {formatTripDateRange(
                          upcomingCountryTrip.startDate,
                          upcomingCountryTrip.endDate,
                          upcomingCountryTrip.itinerary.preferencesSnapshot.partialDate
                        )}
                      </bdi>
                    </p>
                  ) : null}
                </section>
              ) : null}

              {isLoading ? (
                <Skeleton className="h-32 rounded-xl" />
              ) : !country ? (
                <>
                  <div className="glass-card flex flex-col items-center gap-3 px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {displayName} עדיין לא ברשימה שלך.
                    </p>
                    <StatusSelect
                      value={pendingStatus}
                      onChange={handleAddCountry}
                      disabled={upsertCountry.isPending}
                    />
                  </div>

                  <Separator />

                  <section>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                      <Bot className="size-3.5 text-primary" />
                      המלצות AI
                    </h3>
                    <CountryAiRecommendations isoA2={iso} countryName={displayName} compact />
                  </section>
                </>
              ) : (
                <>
                  {!hasCountryTrips && (
                    <>
                      <section>
                        <h3 className="mb-2 text-sm font-medium">סטטוס</h3>
                        <StatusSelect
                          value={country.status}
                          onChange={handleStatusChange}
                          disabled={upsertCountry.isPending}
                        />
                      </section>

                      <Separator />
                    </>
                  )}

                  <section>
                    <h3 className="mb-2 text-sm font-medium">סקירה כללית</h3>
                    <p className="text-sm text-muted-foreground">
                      {country.overview || "אין עדיין סקירה כללית."}
                    </p>
                  </section>

                  <Separator />

                  <section>
                    <h3 className="mb-2 text-sm font-medium">הערות</h3>
                    <p className="text-sm text-muted-foreground">
                      {country.notes || "אין עדיין הערות."}
                    </p>
                  </section>

                  <Separator />

                  <section>
                    <h3 className="mb-2 text-sm font-medium">ערים</h3>
                    <p className="text-sm text-muted-foreground">
                      {cities && cities.length > 0
                        ? `${cities.length} ערים נוספו`
                        : "לא נוספו ערים עדיין."}
                    </p>
                  </section>

                  <Separator />

                  <section>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                      <Bot className="size-3.5 text-primary" />
                      המלצות AI
                    </h3>
                    <CountryAiRecommendations isoA2={iso} countryName={country.name} compact />
                  </section>
                </>
              )}

              <Button
                variant="outline"
                className="w-full gap-2"
                nativeButton={false}
                render={<Link href={`/countries/${iso.toLowerCase()}`} />}
              >
                צפייה בדף המדינה המלא
                <ArrowRight className="size-4 rotate-180" />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
