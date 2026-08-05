"use client";

import type { ReactNode } from "react";
import { ArrowRight, Star } from "lucide-react";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import Link from "next/link";
import { useEffect, useState } from "react";

import { CountryAddCard } from "@/components/country/country-add-card";
import { CountryTripWorkspaceContent } from "@/components/country/country-trip-workspace";
import { useCountryTripWorkspace } from "@/components/country/use-country-trip-workspace";
import { STATUS_LABELS } from "@/components/map/status-colors";
import { CountryAiRecommendations } from "@/components/shared/country-ai-recommendations";
import { CountryBanner } from "@/components/shared/country-banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorldCountriesGeoJson, type CountryFeatureProperties } from "@/lib/map/geo";
import { useCountryByIso } from "@/lib/queries/countries";
import { cn } from "@/lib/utils";
import {
  TRIP_STATUS_LABELS,
  WORKSPACE_TAB_LABELS,
  getTabOrderForStatus,
  type TripPhase,
  type TripWorkspaceTab,
} from "@/lib/trip-workspace";
import type { Tables } from "@/lib/supabase/types";

function CountryHero({
  iso,
  countryName,
  statusLabel,
  tripStatusLabel,
  rating,
  tabs,
}: {
  iso: string;
  countryName: string;
  statusLabel?: string;
  tripStatusLabel?: string;
  rating?: number | null;
  tabs?: ReactNode;
}) {
  return (
    <section className="relative">
      <CountryBanner
        isoA2={iso}
        countryName={countryName}
        className="h-[22rem] w-full rounded-none sm:h-[26rem] lg:h-[30rem]"
        showCaption={false}
        overlay={
          <>
            <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-black/90" />

            <div className="relative mx-auto flex h-full w-full max-w-[1400px] flex-col px-6 py-6 lg:px-10">
              <div className="flex items-start justify-start">
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/map" />}
                  className="border-white/20 bg-black/30 text-white shadow-lg backdrop-blur-md hover:bg-black/40 hover:text-white dark:border-white/20 dark:bg-black/35"
                >
                  <ArrowRight className="size-4" />
                  חזרה למפה
                </Button>
              </div>

              <div className="flex flex-1 flex-col items-center justify-center pb-10 text-center">
                <div className="w-fit max-w-2xl space-y-4 rounded-[28px] border border-white/15 bg-white/10 p-6 text-white shadow-2xl shadow-black/25 backdrop-blur-xl sm:p-8">
                  <h1 className="font-heading text-5xl font-bold tracking-tight drop-shadow-sm sm:text-6xl lg:text-[3.75rem]">
                    {countryName}
                  </h1>

                  {(statusLabel || tripStatusLabel || rating != null) && (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {statusLabel && (
                        <span className="rounded-full border border-white/15 bg-black/25 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-md">
                          {statusLabel}
                        </span>
                      )}
                      {tripStatusLabel && (
                        <span className="rounded-full border border-white/15 bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur-md">
                          {tripStatusLabel}
                        </span>
                      )}
                      {rating != null && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/25 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-md">
                          <Star className="size-3.5 fill-current text-amber-300" />
                          {rating.toFixed(1)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        }
      />

      {tabs && (
        <div className="relative z-20 mx-auto -mt-7 w-full max-w-[1400px] px-4 sm:px-6 lg:px-10">
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
    <div className="overflow-x-auto rounded-[1.75rem] border border-white/40 bg-white/75 p-2 shadow-2xl shadow-black/10 backdrop-blur-2xl dark:border-white/10 dark:bg-neutral-900/75 sm:p-2.5">
      <TabsList variant="line" className="h-auto w-max min-w-full justify-start gap-1.5 p-0 sm:justify-center">
        {tabOrder.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            className="rounded-full px-4 py-2.5 text-[15px] font-medium text-foreground/70 after:hidden transition-all duration-200 hover:bg-primary/10 hover:text-foreground data-active:bg-primary data-active:font-semibold data-active:text-primary-foreground data-active:shadow-lg data-active:shadow-primary/40"
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
        statusLabel={STATUS_LABELS[country.status]}
        tripStatusLabel={TRIP_STATUS_LABELS[workspace.tripStatus as TripPhase]}
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
  const { data: geojson } = useWorldCountriesGeoJson();

  const feature = geojson?.features.find((item) => item.properties.iso_a2 === iso.toUpperCase());
  const displayName = country?.name ?? feature?.properties.name ?? iso.toUpperCase();

  const bbox = feature?.properties.bbox;
  const centerLon = bbox ? (bbox[0] + bbox[2]) / 2 : undefined;
  const centerLat = bbox ? (bbox[1] + bbox[3]) / 2 : undefined;

  if (isLoading) {
    return (
      <div className="flex min-h-full flex-col">
        <div className="relative">
          <Skeleton className="h-[22rem] w-full rounded-none sm:h-[26rem] lg:h-[30rem]" />

          <div className="relative z-20 mx-auto -mt-7 w-full max-w-[1400px] px-4 sm:px-6 lg:px-10">
            <Skeleton className="h-16 rounded-[1.75rem]" />
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[1400px] flex-col px-4 pt-10 pb-12 sm:px-6 lg:px-10">
          <Skeleton className="h-[32rem] rounded-[2rem]" />
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
