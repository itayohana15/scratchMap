"use client";

import type { ReactNode } from "react";
import { Search } from "lucide-react";

import { STATUS_LABELS } from "@/components/map/status-colors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Status } from "@/lib/supabase/types";

export interface SearchableCountry {
  iso: string;
  iso3: string | null;
  name: string;
  status?: Status;
}

export interface CountrySidebarEntry {
  iso: string;
  name: string;
  subtitle?: string;
}

export type MapStatusFilter = "all" | "visited" | "planned" | "not_visited";

const STATUS_FILTERS: Array<{ value: MapStatusFilter; label: string }> = [
  { value: "all", label: "הכל" },
  { value: "visited", label: "ביקרתי" },
  { value: "planned", label: "מתוכנן" },
  { value: "not_visited", label: "לא ביקרתי" },
];

const MAX_LIST_RESULTS = 10;
const MAX_GROUP_ROWS = 5;

function countryFlag(iso: string) {
  const normalizedIso = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedIso)) return "🏳️";

  return String.fromCodePoint(
    ...Array.from(normalizedIso, (char) => 127397 + char.charCodeAt(0))
  );
}

function CountryRow({
  iso,
  name,
  subtitle,
  right,
  isSelected,
  onSelect,
}: {
  iso: string;
  name: string;
  subtitle?: string;
  right?: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      title={iso}
      className={cn(
        "h-auto w-full justify-between rounded-xl border border-transparent px-3 py-2 text-right hover:border-border/80 hover:bg-background/80",
        isSelected && "border-border bg-background shadow-sm"
      )}
      onClick={onSelect}
    >
      <span className="inline-flex min-w-0 max-w-full flex-row-reverse items-center gap-2 truncate">
        <span className="shrink-0" aria-hidden="true">
          {countryFlag(iso)}
        </span>
        <span className="flex min-w-0 flex-col items-start truncate">
          <span className="truncate font-medium">{name}</span>
          {subtitle ? (
            <span className="truncate text-xs text-muted-foreground">
              <bdi dir="ltr">{subtitle}</bdi>
            </span>
          ) : null}
        </span>
      </span>
      {right}
    </Button>
  );
}

function GroupSection({
  title,
  entries,
  selectedIso,
  onCountrySelect,
}: {
  title: string;
  entries: CountrySidebarEntry[];
  selectedIso: string | null;
  onCountrySelect: (iso: string) => void;
}) {
  if (entries.length === 0) return null;

  const visible = entries.slice(0, MAX_GROUP_ROWS);
  const hidden = entries.length - visible.length;

  return (
    <div className="space-y-1.5">
      <p className="px-1 text-xs font-semibold text-muted-foreground">{title}</p>
      <div className="space-y-1">
        {visible.map((entry) => (
          <CountryRow
            key={entry.iso}
            iso={entry.iso}
            name={entry.name}
            subtitle={entry.subtitle}
            isSelected={selectedIso === entry.iso}
            onSelect={() => onCountrySelect(entry.iso)}
          />
        ))}
      </div>
      {hidden > 0 ? <p className="px-1 text-xs text-muted-foreground">ועוד {hidden} מדינות</p> : null}
    </div>
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
  statusFilter: MapStatusFilter;
  onStatusFilterChange: (value: MapStatusFilter) => void;
  upcomingEntries: CountrySidebarEntry[];
  visitedEntries: CountrySidebarEntry[];
  recentEntries: CountrySidebarEntry[];
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
  statusFilter,
  onStatusFilterChange,
  upcomingEntries,
  visitedEntries,
  recentEntries,
}: MapSidebarProps) {
  const trimmedQuery = query.trim();
  const isDefaultView = !trimmedQuery && statusFilter === "all";

  const visibleList = countries.slice(0, MAX_LIST_RESULTS);
  const hiddenListCount = Math.max(countries.length - MAX_LIST_RESULTS, 0);

  const hasDefaultContent =
    upcomingEntries.length > 0 || visitedEntries.length > 0 || recentEntries.length > 0;

  return (
    <aside className="flex min-h-[320px] flex-col gap-4 lg:h-full lg:min-h-0">
      <Card className="flex min-h-0 flex-1 flex-col rounded-3xl border border-border/70 bg-card/95 shadow-sm backdrop-blur-sm">
        <CardHeader className="shrink-0 border-b border-border/60 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4 text-primary" />
            חיפוש מדינות
          </CardTitle>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-3">
          <div className="relative shrink-0">
            <Search className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="חפשו מדינה..."
              className="h-10 pr-9"
            />
          </div>

          <div className="flex shrink-0 flex-wrap gap-1.5">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => onStatusFilterChange(filter.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  statusFilter === filter.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-hover hover:text-foreground"
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {!isDefaultView ? (
            <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
              <span>{trimmedQuery ? `${countries.length} תוצאות` : `מתוך ${totalCountries} מדינות`}</span>
              {selectedIso && <span className="truncate">נבחרה: {selectedLabel ?? selectedIso}</span>}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/60 bg-muted/20 p-2.5">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-11 rounded-xl" />
                <Skeleton className="h-11 rounded-xl" />
                <Skeleton className="h-11 rounded-xl" />
              </div>
            ) : isDefaultView ? (
              hasDefaultContent ? (
                <div className="space-y-3 overflow-hidden">
                  <GroupSection
                    title="הטיולים הקרובים שלי"
                    entries={upcomingEntries}
                    selectedIso={selectedIso}
                    onCountrySelect={onCountrySelect}
                  />
                  <GroupSection
                    title="מדינות שביקרתי"
                    entries={visitedEntries}
                    selectedIso={selectedIso}
                    onCountrySelect={onCountrySelect}
                  />
                  <GroupSection
                    title="נצפו לאחרונה"
                    entries={recentEntries}
                    selectedIso={selectedIso}
                    onCountrySelect={onCountrySelect}
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                  חפשו מדינה למעלה כדי להתחיל, או לחצו על מדינה במפה.
                </div>
              )
            ) : (
              <div className="space-y-1 overflow-hidden">
                {visibleList.length > 0 ? (
                  visibleList.map((country) => (
                    <CountryRow
                      key={country.iso}
                      iso={country.iso}
                      name={country.name}
                      isSelected={selectedIso === country.iso}
                      onSelect={() => onCountrySelect(country.iso)}
                      right={
                        <Badge variant={country.status ? "secondary" : "outline"}>
                          {country.status ? STATUS_LABELS[country.status] : "לא נשמרה"}
                        </Badge>
                      }
                    />
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                    לא נמצאו מדינות שתואמות לחיפוש.
                  </div>
                )}
                {hiddenListCount > 0 ? (
                  <p className="px-1 pt-1 text-xs text-muted-foreground">
                    {trimmedQuery
                      ? `ועוד ${hiddenListCount} תוצאות — המשיכו להקליד כדי לצמצם`
                      : `ועוד ${hiddenListCount} מדינות — הקלידו כדי לחפש`}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </aside>
  );
}
