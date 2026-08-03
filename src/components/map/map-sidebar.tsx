"use client";

import { Filter, Search } from "lucide-react";

import { STATUS_LABELS } from "@/components/map/status-colors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Status } from "@/lib/supabase/types";

export interface SearchableCountry {
  iso: string;
  iso3: string | null;
  name: string;
  status?: Status;
}

function countryFlag(iso: string) {
  const normalizedIso = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedIso)) return "🏳️";

  return String.fromCodePoint(
    ...Array.from(normalizedIso, (char) => 127397 + char.charCodeAt(0))
  );
}

interface MapSidebarProps {
  countries: SearchableCountry[];
  isLoading: boolean;
  onCountrySelect: (iso: string) => void;
  onQueryChange: (value: string) => void;
  query: string;
  selectedLabel: string | null;
  selectedIso: string | null;
  totalCountries: number;
}

export function MapSidebar({
  countries,
  isLoading,
  onCountrySelect,
  onQueryChange,
  query,
  selectedLabel,
  selectedIso,
  totalCountries,
}: MapSidebarProps) {
  const resultLabel = query.trim()
    ? `${countries.length} תוצאות`
    : `${totalCountries} מדינות זמינות`;

  return (
    <aside className="flex min-h-[320px] flex-col gap-4 lg:h-full lg:min-h-0">
      <Card className="flex-1 rounded-3xl border border-border/70 bg-card/95 shadow-sm backdrop-blur-sm">
        <CardHeader className="border-b border-border/60">
          <CardTitle className="flex items-center gap-2">
            <Search className="size-4 text-primary" />
            חיפוש מדינות
          </CardTitle>
          <CardDescription>
            חפשו מדינה לפי שם או קוד, ובהמשך תוכלו להוסיף כאן עוד פילטרים.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 pt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="חפשו מדינה..."
              className="h-10 pr-9"
            />
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{resultLabel}</span>
            {selectedIso && (
              <span className="truncate">
                נבחרה: {selectedLabel ?? selectedIso}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 rounded-2xl border border-border/60 bg-muted/20">
            {isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-12 rounded-xl" />
                <Skeleton className="h-12 rounded-xl" />
                <Skeleton className="h-12 rounded-xl" />
                <Skeleton className="h-12 rounded-xl" />
              </div>
            ) : (
              <ScrollArea className="h-[260px] lg:h-full">
                <div className="space-y-2 p-3">
                  {countries.length > 0 ? (
                    countries.map((country) => {
                      const isSelected = selectedIso === country.iso;

                      return (
                        <Button
                          key={country.iso}
                          type="button"
                          variant="ghost"
                          className={cn(
                            "h-auto w-full justify-between rounded-xl border border-transparent px-3 py-3 text-right hover:border-border/80 hover:bg-background/80",
                            isSelected && "border-border bg-background shadow-sm"
                          )}
                          onClick={() => onCountrySelect(country.iso)}
                        >
                          <span className="min-w-0 text-right">
                            <span className="inline-flex max-w-full flex-row-reverse items-center gap-2 truncate font-medium">
                              <span className="shrink-0" aria-hidden="true">
                                {countryFlag(country.iso)}
                              </span>
                              <span className="truncate">{country.name}</span>
                            </span>
                            <span
                              dir="ltr"
                              className="mt-1 block text-[0.72rem] text-muted-foreground"
                            >
                              {country.iso}
                              {country.iso3 ? ` · ${country.iso3}` : ""}
                            </span>
                          </span>

                          <Badge variant={country.status ? "secondary" : "outline"}>
                            {country.status ? STATUS_LABELS[country.status] : "לא נשמרה"}
                          </Badge>
                        </Button>
                      );
                    })
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                      לא נמצאו מדינות שתואמות לחיפוש.
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border border-dashed border-border/70 bg-card/80 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="size-4 text-primary" />
            אזור לפילטרים נוספים
          </CardTitle>
          <CardDescription>
            השארתי כאן מקום מסודר כדי שתוכלו להוסיף בהמשך פילטרים נוספים בלי לשנות את מבנה
            העמוד.
          </CardDescription>
        </CardHeader>
      </Card>
    </aside>
  );
}
