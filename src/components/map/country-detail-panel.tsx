"use client";

import { ArrowRight, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { STATUS_LABELS } from "@/components/map/status-colors";
import { StatusSelect } from "@/components/shared/status-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useCitiesByCountry } from "@/lib/queries/cities";
import { useCountryByIso, useUpsertCountry } from "@/lib/queries/countries";
import type { Status } from "@/lib/supabase/types";

interface CountryDetailPanelProps {
  iso: string | null;
  displayName: string;
  iso3: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function countryFlag(iso: string) {
  const normalizedIso = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedIso)) return "🏳️";

  return String.fromCodePoint(
    ...Array.from(normalizedIso, (char) => 127397 + char.charCodeAt(0))
  );
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
  const upsertCountry = useUpsertCountry();
  const [pendingStatus, setPendingStatus] = useState<Status>("planned");

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
            <SheetHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl leading-none" aria-hidden="true">
                  {countryFlag(iso)}
                </span>
                <SheetTitle className="text-2xl font-semibold">
                  {country?.name ?? displayName}
                </SheetTitle>
              </div>
              {country && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="secondary">{STATUS_LABELS[country.status]}</Badge>
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
              {isLoading ? (
                <Skeleton className="h-32 rounded-xl" />
              ) : !country ? (
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
              ) : (
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
