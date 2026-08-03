"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { useTheme } from "next-themes";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { CityDetailPanel } from "@/components/map/city-detail-panel";
import { CityMarkers } from "@/components/map/city-markers";
import { CountryDetailPanel } from "@/components/map/country-detail-panel";
import { MapSidebar, type SearchableCountry } from "@/components/map/map-sidebar";
import { MapControls } from "@/components/map/map-controls";
import { MapLegend } from "@/components/map/map-legend";
import { useMaplibreMap } from "@/components/map/use-maplibre-map";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorldCountriesGeoJson } from "@/lib/map/geo";
import { useCitiesByCountry } from "@/lib/queries/cities";
import { useCountries, useCountryByIso } from "@/lib/queries/countries";
import type { Status, Tables } from "@/lib/supabase/types";

function normalizeCountryQuery(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function countrySearchFields(country: SearchableCountry) {
  return [
    normalizeCountryQuery(country.name),
    normalizeCountryQuery(country.iso),
    normalizeCountryQuery(country.iso3 ?? ""),
  ];
}

function matchesCountryQuery(country: SearchableCountry, query: string) {
  return countrySearchFields(country).some((field) => field.includes(query));
}

function countrySearchRank(country: SearchableCountry, query: string) {
  const [name, iso, iso3] = countrySearchFields(country);

  if (name === query || iso === query || iso3 === query) return 0;
  if (name.startsWith(query)) return 1;
  if (iso.startsWith(query) || iso3.startsWith(query)) return 2;
  if (name.includes(query)) return 3;
  return 4;
}

export function WorldMap() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const [stage, setStage] = useState<"world" | "country">("world");
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  const [countryQuery, setCountryQuery] = useState("");
  const [countryPanelOpen, setCountryPanelOpen] = useState(false);
  const [selectedCity, setSelectedCity] = useState<Tables<"cities"> | null>(null);
  const [cityPanelOpen, setCityPanelOpen] = useState(false);
  const deferredCountryQuery = useDeferredValue(countryQuery);

  const { data: geojson, isLoading: isGeoJsonLoading } = useWorldCountriesGeoJson();
  const { data: countries } = useCountries();
  const { data: selectedCountry } = useCountryByIso(selectedIso ?? undefined);
  const { data: cities } = useCitiesByCountry(selectedCountry?.id);

  const handleCountryClick = useCallback(
    (iso: string) => {
      const feature = geojson?.features.find((f) => f.properties.iso_a2 === iso);
      if (!feature) return;
      flyToBbox(feature.properties.bbox);
      setStage("country");
      setSelectedIso(iso);
      setCountryPanelOpen(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geojson]
  );

  const { containerRef, mapRef, ready, syncCountryStatuses, flyToBbox, resetToWorld } =
    useMaplibreMap({ isDark, onCountryClick: handleCountryClick, geojson });

  useEffect(() => {
    if (!ready || !countries) return;
    const statuses: Record<string, Status> = {};
    for (const country of countries) {
      statuses[country.iso_a2] = country.status;
    }
    syncCountryStatuses(statuses);
  }, [ready, countries, syncCountryStatuses]);

  const handleBackToWorld = useCallback(() => {
    resetToWorld();
    setStage("world");
    setSelectedIso(null);
    setCountryPanelOpen(false);
  }, [resetToWorld]);

  const handleCityClick = useCallback((city: Tables<"cities">) => {
    setSelectedCity(city);
    setCityPanelOpen(true);
  }, []);

  const cityForPanel = useMemo(
    () => (selectedCity ? { ...selectedCity, countryName: selectedCountry?.name } : null),
    [selectedCity, selectedCountry?.name]
  );

  const selectedFeature = useMemo(
    () => geojson?.features.find((f) => f.properties.iso_a2 === selectedIso) ?? null,
    [geojson, selectedIso]
  );

  const searchableCountries = useMemo(() => {
    if (!geojson) return [];

    const statusesByIso = new Map(
      (countries ?? []).map((country) => [country.iso_a2.toUpperCase(), country.status])
    );

    return geojson.features
      .map((feature) => ({
        iso: feature.properties.iso_a2,
        iso3: feature.properties.iso_a3,
        name: feature.properties.name,
        status: statusesByIso.get(feature.properties.iso_a2.toUpperCase()),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [countries, geojson]);

  const filteredCountries = useMemo(() => {
    const normalizedQuery = normalizeCountryQuery(deferredCountryQuery);

    if (!normalizedQuery) return searchableCountries;

    return searchableCountries
      .filter((country) => matchesCountryQuery(country, normalizedQuery))
      .sort((left, right) => {
        const rankDiff =
          countrySearchRank(left, normalizedQuery) - countrySearchRank(right, normalizedQuery);
        if (rankDiff !== 0) return rankDiff;
        return left.name.localeCompare(right.name);
      });
  }, [deferredCountryQuery, searchableCountries]);

  return (
    <>
      <div className="grid h-full min-h-0 gap-4 overflow-hidden lg:grid-cols-[minmax(18rem,15fr)_minmax(0,85fr)]">
        <div className="relative min-h-0 overflow-hidden rounded-3xl border border-border lg:order-2 lg:h-full">
          {!ready && <Skeleton className="absolute inset-0 rounded-3xl" />}
          <div ref={containerRef} className="h-full w-full" />

          <MapControls
            showBackToWorld={stage === "country"}
            onBackToWorld={handleBackToWorld}
            countryName={selectedCountry?.name}
          />

          <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
            <MapLegend />
          </div>

          <CityMarkers
            map={stage === "country" && ready ? mapRef.current : null}
            cities={cities ?? []}
            isDark={isDark}
            onCityClick={handleCityClick}
          />
        </div>

        <div className="lg:order-1 lg:min-h-0 lg:h-full">
          <MapSidebar
            countries={filteredCountries}
            isLoading={isGeoJsonLoading}
            onCountrySelect={handleCountryClick}
            onQueryChange={setCountryQuery}
            query={countryQuery}
            selectedLabel={selectedFeature?.properties.name ?? selectedCountry?.name ?? null}
            selectedIso={selectedIso}
            totalCountries={searchableCountries.length}
          />
        </div>
      </div>

      <CountryDetailPanel
        iso={selectedIso}
        displayName={selectedFeature?.properties.name ?? selectedCountry?.name ?? ""}
        iso3={selectedFeature?.properties.iso_a3 ?? null}
        open={countryPanelOpen}
        onOpenChange={setCountryPanelOpen}
      />

      <CityDetailPanel city={cityForPanel} open={cityPanelOpen} onOpenChange={setCityPanelOpen} />
    </>
  );
}
