"use client";

import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CountryAddCard } from "@/components/country/country-add-card";
import { CountryQuickFacts } from "@/components/country/country-quick-facts";
import { CountryTripWorkspaceContent } from "@/components/country/country-trip-workspace";
import { useCountryTripWorkspace } from "@/components/country/use-country-trip-workspace";
import { STATUS_COLORS } from "@/components/map/status-colors";
import { CountryAiRecommendations } from "@/components/shared/country-ai-recommendations";
import { CountryBanner } from "@/components/shared/country-banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { computeCountryFeatureMapFocus } from "@/lib/map/focus";
import { useWorldCountriesGeoJson, type CountryFeatureProperties } from "@/lib/map/geo";
import { useCountryByIso, useUpsertCountry } from "@/lib/queries/countries";
import { cn } from "@/lib/utils";
import {
  WORKSPACE_TAB_LABELS,
  getTabOrderForStatus,
  type TripWorkspaceTab,
} from "@/lib/trip-workspace";
import type { Status, Tables } from "@/lib/supabase/types";

const TAB_EMOJIS: Record<TripWorkspaceTab, string> = {
  overview: "🧭",
  itinerary: "🧳",
  map: "🗺️",
  recommendations: "⭐",
  budget: "💰",
  country_summary: "🧾",
  practical: "ℹ️",
  currency: "💱",
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

function CountryHero({
  iso,
  countryName,
  countryStatus,
}: {
  iso: string;
  countryName: string;
  countryStatus?: Status;
}) {
  const accentColor = countryStatus ? STATUS_COLORS[countryStatus].light : "#94a3b8";
  const flagUrl = `/flags/${iso.toLowerCase()}.png`;

  return (
    <section className="relative bg-background" style={{ "--country-accent": accentColor } as CSSProperties}>
      <CountryBanner
        isoA2={iso}
        countryName={countryName}
        className="min-h-[9rem] w-full rounded-none sm:min-h-[10.5rem] lg:min-h-[12rem]"
        showCaption={false}
        showFlagOverlay={false}
        imageAlt={`תמונת רקע של ${countryName}`}
        scrimClassName="bg-gradient-to-b from-black/48 via-black/22 to-black/55"
        overlay={
          <>
            <div className="absolute inset-0 bg-slate-950/22" />
            <div
              className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl sm:h-28 sm:w-28"
              style={{ backgroundColor: hexToRgba(accentColor, 0.18) }}
            />
            <div className="absolute left-[3vw] top-4 z-10">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href="/map" />}
                className="h-9 rounded-full border-white/16 bg-black/28 px-4 text-white shadow-[0_12px_28px_rgba(0,0,0,0.22)] backdrop-blur-sm transition-colors duration-200 hover:bg-black/36"
              >
                <ArrowRight className="size-4" />
                חזרה למפה
              </Button>
            </div>

            <div className="relative mx-auto flex h-full w-full max-w-[1400px] items-center justify-center px-4 py-4 text-center sm:px-6 sm:py-5 lg:px-8">
              <div className="flex items-center gap-4 text-white">
                <span className="overflow-hidden rounded-2xl border border-white/22 shadow-[0_14px_28px_rgba(0,0,0,0.2)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={flagUrl} alt={`דגל ${countryName}`} className="size-12 object-cover sm:size-14" />
                </span>

                <h1 className="font-heading text-[1.9rem] font-bold leading-none tracking-tight text-white drop-shadow-[0_10px_24px_rgba(0,0,0,0.34)] sm:text-[2.25rem] lg:text-[2.5rem]">
                  {countryName}
                </h1>
              </div>
            </div>
          </>
        }
      />
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
  const accentColor = STATUS_COLORS[country.status].light;
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

  const sidebarNav = (
    <TabsList
      variant="line"
      className="h-auto w-full flex-col items-stretch gap-1 p-0 sm:justify-start"
    >
      {tabOrder.map((tab) => (
        <TabsTrigger
          key={tab}
          value={tab}
          className="w-full justify-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[15px] font-medium text-muted-foreground after:hidden hover:bg-muted hover:text-foreground data-active:bg-[color-mix(in_srgb,var(--country-accent)_14%,transparent)] data-active:font-semibold data-active:text-[color:var(--country-accent)]"
        >
          <span aria-hidden className="text-base leading-none">
            {TAB_EMOJIS[tab]}
          </span>
          {WORKSPACE_TAB_LABELS[tab]}
        </TabsTrigger>
      ))}
    </TabsList>
  );

  return (
    <div
      className="min-h-full bg-background text-foreground"
      style={{ "--country-accent": accentColor } as CSSProperties}
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as TripWorkspaceTab)}
        orientation="vertical"
        className={cn("flex min-h-full flex-col")}
      >
        <CountryHero
          iso={iso}
          countryName={country.name}
          countryStatus={country.status}
        />

        <div className="flex w-full flex-col gap-6 px-[3vw] pt-6 pb-12 lg:flex-row">
          <aside className="shrink-0 lg:sticky lg:top-4 lg:h-fit lg:w-60">
            <nav className="rounded-2xl border border-border/70 bg-card/60 p-2">{sidebarNav}</nav>
          </aside>

          <div className="min-w-0 flex-1 space-y-8">
            <CountryQuickFacts isoA2={iso} accentColor={accentColor} />

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
        </div>
      </Tabs>
    </div>
  );
}

export function CountryPageClient({ iso }: { iso: string }) {
  const { data: country, isLoading } = useCountryByIso(iso);
  const upsertCountry = useUpsertCountry();
  const { data: geojson } = useWorldCountriesGeoJson();
  const autoCreateAttemptedRef = useRef(false);

  const feature = geojson?.features.find((item) => item.properties.iso_a2 === iso.toUpperCase());
  const displayName = country?.name ?? feature?.properties.name ?? iso.toUpperCase();

  const focus = computeCountryFeatureMapFocus(feature);
  const centerLon = focus?.center[0];
  const centerLat = focus?.center[1];

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
      <div className="flex min-h-full flex-col bg-background text-foreground">
        <div className="relative">
          <Skeleton className="min-h-[9rem] w-full rounded-none sm:min-h-[10.5rem] lg:min-h-[12rem]" />

          <div className="w-full px-[3vw]">
            <Skeleton className="h-16 rounded-[1.75rem]" />
          </div>
        </div>

        <div className="w-full px-[3vw] pt-6">
          <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-[1.5rem]" />
            ))}
          </div>
        </div>

        <div className="flex w-full flex-col px-[3vw] pt-8 pb-12">
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
      <div className="flex min-h-full flex-col bg-background text-foreground">
        <CountryHero iso={iso} countryName={displayName} />

        <div className="flex w-full flex-col gap-6 px-[3vw] pt-8 pb-12">
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
