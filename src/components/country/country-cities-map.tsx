"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { Search } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CityDetailPanel } from "@/components/map/city-detail-panel";
import { CityMarkers } from "@/components/map/city-markers";
import { useCountryMiniMap } from "@/components/country/use-country-mini-map";
import { type MapPlace, PlaceMarkers } from "@/components/country/place-markers";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCitiesByCountry, useUpsertCity } from "@/lib/queries/cities";
import { useWorldCountriesGeoJson } from "@/lib/map/geo";
import { usePlaceSearch, useRecommendedPlaces } from "@/lib/places/country-places";
import type { Tables } from "@/lib/supabase/types";

const RECOMMENDED_COLOR = "#6366f1";
const SEARCH_RESULT_COLOR = "#f97316";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface CountryCitiesMapProps {
  countryId: string;
  countryName: string;
  iso: string;
}

export function CountryCitiesMap({ countryId, countryName, iso }: CountryCitiesMapProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const { data: cities } = useCitiesByCountry(countryId);
  const { data: geojson } = useWorldCountriesGeoJson();
  const upsertCity = useUpsertCity();

  const [selectedCity, setSelectedCity] = useState<Tables<"cities"> | null>(null);
  const [cityPanelOpen, setCityPanelOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResult, setSearchResult] = useState<MapPlace | null>(null);
  const debouncedQuery = useDebouncedValue(searchQuery, 350);
  const { data: searchResults, isFetching: searchLoading } = usePlaceSearch(debouncedQuery, iso);

  const { data: recommendedPlaces } = useRecommendedPlaces(iso);
  const trackedCityNames = new Set((cities ?? []).map((city) => city.name));
  // Once a recommended place has been added as a tracked city, its star
  // marker would sit exactly on top of the new city marker — drop it so
  // the (smaller) city marker underneath isn't blocked from clicks/hover.
  const recommendedMapPlaces: MapPlace[] = (recommendedPlaces ?? [])
    .filter((place) => !trackedCityNames.has(place.label))
    .map((place, i) => ({
      id: `recommended-${i}`,
      label: place.label,
      lat: place.lat,
      lon: place.lon,
      photoQuery: place.name,
    }));

  const feature = geojson?.features.find((f) => f.properties.iso_a2 === iso.toUpperCase());

  const { containerRef, mapRef, ready } = useCountryMiniMap({ isDark, feature });

  async function handleAddPlace(place: MapPlace) {
    try {
      await upsertCity.mutateAsync({
        country_id: countryId,
        name: place.label,
        latitude: place.lat,
        longitude: place.lon,
      });
      toast.success(`${place.label} נוספה`);
    } catch {
      toast.error("הוספת העיר נכשלה — ייתכן שהשם כבר קיים במדינה הזו");
    }
  }

  function handleSelectSearchResult(result: { name: string; lat: number; lon: number }) {
    // Nominatim results can come back Hebrew-translated (Accept-Language: he),
    // which searches poorly on Pexels — the raw text the user typed is
    // usually the place's actual (often English/Latin) name.
    const photoQuery = searchQuery.trim() || result.name;
    setSearchResult({
      id: "search-result",
      label: result.name,
      lat: result.lat,
      lon: result.lon,
      photoQuery,
    });
    setSearchQuery(result.name);
    setSearchOpen(false);
    mapRef.current?.flyTo({ center: [result.lon, result.lat], zoom: 11, duration: 900 });
  }

  return (
    <div className="relative min-h-[22rem] flex-1 overflow-hidden rounded-2xl border border-border">
      {!ready && <Skeleton className="absolute inset-0 rounded-2xl" />}
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute start-3 top-3 z-10 w-64 max-w-[calc(100%-1.5rem)]">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder={`חיפוש מקומות ב${countryName}...`}
            className="w-full bg-popover/95 ps-9 shadow-md backdrop-blur"
          />
        </div>

        {searchOpen && debouncedQuery.trim().length >= 2 && (
          <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
            {searchLoading ? (
              <p className="p-3 text-xs text-muted-foreground">מחפש...</p>
            ) : searchResults && searchResults.length > 0 ? (
              searchResults.map((result, i) => (
                <button
                  key={`${result.name}-${i}`}
                  type="button"
                  className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                  onClick={() => handleSelectSearchResult(result)}
                >
                  {result.name}
                </button>
              ))
            ) : (
              <p className="p-3 text-xs text-muted-foreground">לא נמצאו תוצאות.</p>
            )}
          </div>
        )}
      </div>

      <PlaceMarkers
        map={ready ? mapRef.current : null}
        places={recommendedMapPlaces}
        color={RECOMMENDED_COLOR}
        onAdd={handleAddPlace}
      />

      <PlaceMarkers
        map={ready ? mapRef.current : null}
        places={searchResult ? [searchResult] : []}
        color={SEARCH_RESULT_COLOR}
        onAdd={handleAddPlace}
      />

      <CityMarkers
        map={ready ? mapRef.current : null}
        cities={cities ?? []}
        isDark={isDark}
        onCityClick={(city) => {
          setSelectedCity(city);
          setCityPanelOpen(true);
        }}
      />

      <CityDetailPanel
        city={selectedCity ? { ...selectedCity, countryName } : null}
        open={cityPanelOpen}
        onOpenChange={setCityPanelOpen}
      />
    </div>
  );
}
