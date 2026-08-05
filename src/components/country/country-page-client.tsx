"use client";

import type { ReactNode } from "react";
import { ArrowRight, CalendarDays, Clock3, Settings, Star, Users } from "lucide-react";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CountryAddCard } from "@/components/country/country-add-card";
import { CountryTripWorkspaceContent } from "@/components/country/country-trip-workspace";
import { useCountryTripWorkspace } from "@/components/country/use-country-trip-workspace";
import { STATUS_COLORS, STATUS_LABELS } from "@/components/map/status-colors";
import { CountryAiRecommendations } from "@/components/shared/country-ai-recommendations";
import { CountryBanner } from "@/components/shared/country-banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, tripDurationDays } from "@/lib/format";
import { useWorldCountriesGeoJson, type CountryFeatureProperties } from "@/lib/map/geo";
import { useCountryByIso, useUpsertCountry } from "@/lib/queries/countries";
import { cn } from "@/lib/utils";
import {
  type CountryTripWorkspaceState,
  TRIP_STATUS_LABELS,
  WORKSPACE_TAB_LABELS,
  getTabOrderForStatus,
  type TripPhase,
  type TripWorkspaceTab,
} from "@/lib/trip-workspace";
import type { Status, Tables } from "@/lib/supabase/types";

const HERO_PHASE_ORDER: TripPhase[] = ["planning", "booked", "currently_traveling", "completed"];

const HERO_PHASE_COLORS: Record<TripPhase, string> = {
  planning: "#60a5fa",
  booked: "#f59e0b",
  currently_traveling: "#34d399",
  completed: "#c084fc",
};

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const full = normalized.length === 3
    ? normalized
        .split("")
        .map((char) => `${char}${char}`)
        .join("")
    : normalized;

  const value = Number.parseInt(full, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function formatCompactHeroDateRange(start: string | null | undefined, end: string | null | undefined) {
  const startLabel = start ? formatDate(start, "d MMM") : null;
  const endLabel = end ? formatDate(end, "d MMM") : null;

  if (startLabel && endLabel) return `${startLabel} – ${endLabel}`;
  return startLabel ?? endLabel;
}

function formatTravelerLabel(travelers: number | null | undefined) {
  if (!travelers || travelers <= 0) return null;
  return travelers === 1 ? "מטייל אחד" : `${travelers} מטיילים`;
}

function CountryHero({
  iso,
  countryName,
  countryStatus,
  workspace,
  rating,
  tabs,
}: {
  iso: string;
  countryName: string;
  countryStatus?: Status;
  workspace?: CountryTripWorkspaceState;
  rating?: number | null;
  tabs?: ReactNode;
}) {
  const accentColor = countryStatus ? STATUS_COLORS[countryStatus].light : "#94a3b8";
  const tripStatus = workspace?.tripStatus;
  const flagUrl = `/flags/${iso.toLowerCase()}.png`;
  const compactDateRange = formatCompactHeroDateRange(
    workspace?.preferences.startDate || null,
    workspace?.preferences.endDate || null
  );
  const tripDays = tripDurationDays(
    workspace?.preferences.startDate || null,
    workspace?.preferences.endDate || null
  );
  const travelersLabel = formatTravelerLabel(workspace?.preferences.travelers);
  const quickInfo = [
    compactDateRange
      ? {
          icon: CalendarDays,
          label: compactDateRange,
        }
      : null,
    tripDays
      ? {
          icon: Clock3,
          label: tripDays === 1 ? "יום אחד" : `${tripDays} ימים`,
        }
      : null,
    travelersLabel
      ? {
          icon: Users,
          label: travelersLabel,
        }
      : null,
  ].filter((item): item is { icon: typeof CalendarDays; label: string } => item != null);

  return (
    <section className="relative">
      <CountryBanner
        isoA2={iso}
        countryName={countryName}
        className="h-[10rem] w-full rounded-none sm:h-[11.5rem] lg:h-[13rem]"
        showCaption={false}
        showFlagOverlay={false}
        scrimClassName="bg-gradient-to-b from-[#050912]/45 via-[#050912]/20 to-[#050912]/88"
        overlay={
          <>
            <div
              className="absolute inset-0"
              style={{
                background: `linear-gradient(90deg, rgba(5, 9, 18, 0.08) 0%, rgba(5, 9, 18, 0.14) 34%, ${hexToRgba(accentColor, 0.2)} 100%)`,
              }}
            />

            <div className="relative mx-auto flex h-full w-full max-w-[1400px] flex-col px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
              <div className="flex items-start justify-between gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/map" />}
                  className="border-white/10 bg-black/55 text-white shadow-lg shadow-black/35 transition-all duration-300 hover:bg-black/70 hover:text-white hover:shadow-black/45 dark:border-white/10 dark:bg-black/60"
                >
                  <ArrowRight className="size-4" />
                  חזרה למפה
                </Button>

                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="הגדרות"
                  nativeButton={false}
                  render={<Link href="/settings" />}
                  className="border-white/10 bg-black/55 text-white shadow-lg shadow-black/35 transition-all duration-300 hover:bg-black/70 hover:text-white hover:shadow-black/45 dark:border-white/10 dark:bg-black/60"
                >
                  <Settings className="size-4" />
                </Button>
              </div>

              <div className="mt-auto ml-auto w-full max-w-[42rem]">
                <div
                  className={cn(
                    "group relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#09101b]/92 text-white shadow-[0_24px_60px_-28px_rgba(0,0,0,0.9)] transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-[0_30px_70px_-28px_rgba(0,0,0,0.92)] active:translate-y-0 active:scale-[0.995]"
                  )}
                >
                  <div
                    className="absolute inset-0 opacity-90"
                    style={{
                      background: `linear-gradient(135deg, ${hexToRgba(accentColor, 0.12)} 0%, rgba(9, 16, 27, 0.94) 32%, rgba(9, 16, 27, 0.98) 100%)`,
                    }}
                  />
                  <div
                    className="absolute inset-y-5 right-0 w-1 rounded-full"
                    style={{ backgroundColor: accentColor }}
                  />
                  <div
                    className="absolute -top-12 left-[-2rem] h-28 w-28 rounded-full opacity-40 blur-3xl"
                    style={{ backgroundColor: hexToRgba(accentColor, 0.22) }}
                  />
                  <div className="absolute inset-[1px] rounded-[calc(2rem-1px)] border border-white/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" />

                  <div className="relative flex flex-col gap-3 px-4 py-4 sm:px-5 sm:py-5 lg:px-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-3 text-right">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-white/72">
                          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 shadow-sm">
                            <span className="overflow-hidden rounded-full border border-white/10">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={flagUrl} alt="" className="size-5 object-cover" />
                            </span>
                            <span>מרחב טיול</span>
                          </span>

                          {countryStatus && (
                            <span
                              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-white/80"
                              style={{
                                backgroundColor: hexToRgba(accentColor, 0.12),
                                borderColor: hexToRgba(accentColor, 0.3),
                              }}
                            >
                              <span className="size-1.5 rounded-full" style={{ backgroundColor: accentColor }} />
                              {STATUS_LABELS[countryStatus]}
                            </span>
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-end gap-3 text-[11px] font-medium tracking-[0.18em] text-white/45">
                            <span
                              className="h-px w-10 rounded-full"
                              style={{ backgroundColor: hexToRgba(accentColor, 0.85) }}
                            />
                            <span>TRIP DASHBOARD</span>
                          </div>

                          <h1 className="font-heading max-w-[16ch] overflow-hidden text-[1.95rem] font-bold leading-[1.05] tracking-tight text-white drop-shadow-[0_10px_28px_rgba(0,0,0,0.55)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] sm:text-[2.35rem] lg:text-[2.7rem]">
                            {countryName}
                          </h1>
                        </div>

                        {quickInfo.length > 0 && (
                          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-white/68 sm:text-sm">
                            {quickInfo.map(({ icon: Icon, label }, index) => (
                              <div key={label} className="contents">
                                <span className="inline-flex items-center gap-1.5">
                                  <Icon className="size-3.5 text-white/45" />
                                  <span>{label}</span>
                                </span>
                                {index < quickInfo.length - 1 && (
                                  <span className="size-1 rounded-full bg-white/18" aria-hidden="true" />
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {tripStatus && (
                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            {HERO_PHASE_ORDER.map((phase) => {
                              const phaseColor = HERO_PHASE_COLORS[phase];
                              const isActive = phase === tripStatus;
                              return (
                                <span
                                  key={phase}
                                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-all duration-300 sm:text-xs"
                                  style={
                                    isActive
                                      ? {
                                          backgroundColor: hexToRgba(phaseColor, 0.16),
                                          borderColor: hexToRgba(phaseColor, 0.34),
                                          color: "rgba(255,255,255,0.96)",
                                        }
                                      : {
                                          backgroundColor: "rgba(255,255,255,0.035)",
                                          borderColor: "rgba(255,255,255,0.08)",
                                          color: "rgba(255,255,255,0.56)",
                                        }
                                  }
                                >
                                  <span
                                    className="size-1.5 rounded-full"
                                    style={{ backgroundColor: phaseColor, opacity: isActive ? 1 : 0.72 }}
                                  />
                                  {TRIP_STATUS_LABELS[phase]}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {rating != null && (
                        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-white/84 shadow-sm">
                          <Star className="size-3.5 fill-current text-amber-300" />
                          {rating.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        }
      />

      {tabs && (
        <div className="relative z-20 mx-auto -mt-5 w-full max-w-[1400px] px-4 sm:px-6 lg:px-10">
          {tabs}
        </div>
      )}
    </section>
  );
}

function CountryWorkspaceView({
  country,
  iso,
  feature,
  centerLat,
  centerLon,
}: {
  country: Tables<"countries">;
  iso: string;
  feature: Feature<Polygon | MultiPolygon, CountryFeatureProperties> | undefined;
  centerLat: number | undefined;
  centerLon: number | undefined;
}) {
  const workspaceController = useCountryTripWorkspace(country.id, country.name);
  const { workspace, hydrated } = workspaceController;
  const tabOrder = getTabOrderForStatus(workspace.tripStatus);
  const [activeTab, setActiveTab] = useState<TripWorkspaceTab>(tabOrder[0] ?? "overview");

  useEffect(() => {
    if (!tabOrder.includes(activeTab)) {
      setActiveTab(tabOrder[0] ?? "overview");
    }
  }, [activeTab, tabOrder]);

  useEffect(() => {
    if (!hydrated) return;
    setActiveTab((current) => (tabOrder.includes(current) ? current : tabOrder[0] ?? "overview"));
  }, [hydrated, tabOrder]);

  const tabsRail = (
    <div className="overflow-x-auto rounded-[1.75rem] border border-white/8 bg-[#0c121d]/96 p-2 shadow-[0_24px_50px_-30px_rgba(0,0,0,0.9)] sm:p-2.5">
      <TabsList variant="line" className="h-auto w-max min-w-full justify-start gap-1.5 p-0 sm:justify-center">
        {tabOrder.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            className="rounded-full px-4 py-2.5 text-[15px] font-medium text-white/58 after:hidden transition-all duration-200 hover:bg-white/6 hover:text-white data-active:bg-white data-active:font-semibold data-active:text-[#09101b] data-active:shadow-[0_14px_28px_-16px_rgba(255,255,255,0.65)]"
          >
            {WORKSPACE_TAB_LABELS[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as TripWorkspaceTab)}
      className={cn("flex min-h-full flex-col")}
    >
      <CountryHero
        iso={iso}
        countryName={country.name}
        countryStatus={country.status}
        workspace={workspace}
        rating={country.rating}
        tabs={tabsRail}
      />

      <div className="mx-auto flex w-full max-w-[1400px] flex-col px-4 pt-10 pb-12 sm:px-6 lg:px-10">
        <CountryTripWorkspaceContent
          activeTab={activeTab}
          country={country}
          iso={iso}
          feature={feature}
          centerLat={centerLat}
          centerLon={centerLon}
          workspaceController={workspaceController}
        />
      </div>
    </Tabs>
  );
}

export function CountryPageClient({ iso }: { iso: string }) {
  const { data: country, isLoading } = useCountryByIso(iso);
  const upsertCountry = useUpsertCountry();
  const { data: geojson } = useWorldCountriesGeoJson();
  const autoCreateAttemptedRef = useRef(false);

  const feature = geojson?.features.find((item) => item.properties.iso_a2 === iso.toUpperCase());
  const displayName = country?.name ?? feature?.properties.name ?? iso.toUpperCase();

  const bbox = feature?.properties.bbox;
  const centerLon = bbox ? (bbox[0] + bbox[2]) / 2 : undefined;
  const centerLat = bbox ? (bbox[1] + bbox[3]) / 2 : undefined;

  useEffect(() => {
    if (isLoading || country || autoCreateAttemptedRef.current) return;

    autoCreateAttemptedRef.current = true;
    upsertCountry
      .mutateAsync({
        name: displayName,
        iso_a2: iso.toUpperCase(),
        iso_a3: feature?.properties.iso_a3 ?? null,
        status: "not_visited",
      })
      .catch(() => {
        autoCreateAttemptedRef.current = false;
        toast.error("לא הצלחנו לפתוח את המדינה אוטומטית. אפשר להוסיף אותה ידנית.");
      });
  }, [country, displayName, feature?.properties.iso_a3, isLoading, iso, upsertCountry]);

  if (isLoading || (!country && upsertCountry.isPending)) {
    return (
      <div className="flex min-h-full flex-col">
        <div className="relative">
          <Skeleton className="h-[10rem] w-full rounded-none sm:h-[11.5rem] lg:h-[13rem]" />

          <div className="relative z-20 mx-auto -mt-5 w-full max-w-[1400px] px-4 sm:px-6 lg:px-10">
            <Skeleton className="h-16 rounded-[1.75rem]" />
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[1400px] flex-col px-4 pt-10 pb-12 sm:px-6 lg:px-10">
          <div className="section-card flex min-h-[18rem] items-center justify-center p-6 text-center">
            <div className="space-y-3">
              <Skeleton className="mx-auto h-10 w-48 rounded-full" />
              <p className="text-sm text-muted-foreground">פותחים workspace לתכנון הטיול...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!country) {
    return (
      <div className="flex min-h-full flex-col">
        <CountryHero iso={iso} countryName={displayName} />

        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 pt-10 pb-12 sm:px-6 lg:px-10">
          <CountryAddCard iso={iso} name={displayName} iso3={feature?.properties.iso_a3 ?? null} />
          <div className="section-card p-6">
            <CountryAiRecommendations isoA2={iso} countryName={displayName} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <CountryWorkspaceView
      country={country}
      iso={iso}
      feature={feature}
      centerLat={centerLat}
      centerLon={centerLon}
    />
  );
}
