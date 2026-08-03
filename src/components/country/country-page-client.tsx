"use client";

import { Bot, Bus, CloudSun } from "lucide-react";

import { CountryAddCard } from "@/components/country/country-add-card";
import { CountryCitiesSection } from "@/components/country/country-cities-section";
import { CountryNotesSection } from "@/components/country/country-notes-section";
import { CountryOverviewSection } from "@/components/country/country-overview-section";
import { CountryRatingsSection } from "@/components/country/country-ratings-section";
import { CountryStatsSection } from "@/components/country/country-stats-section";
import { CountryTimelineSection } from "@/components/country/country-timeline-section";
import { PhotoGallery } from "@/components/gallery/photo-gallery";
import { PlaceholderSection } from "@/components/shared/placeholder-section";
import { PlacesSection } from "@/components/shared/places-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorldCountriesGeoJson } from "@/lib/map/geo";
import { useCountryByIso } from "@/lib/queries/countries";
import { formatCurrency } from "@/lib/format";
import { useCountryStats } from "@/lib/queries/stats";

const TABS = [
  "overview",
  "weather",
  "cities",
  "hotels",
  "restaurants",
  "transportation",
  "budget",
  "gallery",
  "timeline",
  "notes",
  "ratings",
  "stats",
  "ai",
] as const;

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  overview: "סקירה כללית",
  weather: "מזג אוויר",
  cities: "ערים",
  hotels: "מלונות",
  restaurants: "מסעדות",
  transportation: "תחבורה",
  budget: "תקציב",
  gallery: "גלריה",
  timeline: "ציר זמן",
  notes: "הערות",
  ratings: "דירוגים",
  stats: "סטטיסטיקה",
  ai: "המלצות AI",
};

function BudgetSection({ countryId }: { countryId: string }) {
  const { data: stats, isLoading } = useCountryStats(countryId);
  if (isLoading || !stats) return <Skeleton className="h-24 rounded-xl" />;

  const perDay = stats.totalDays > 0 ? stats.totalCost / stats.totalDays : null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div className="glass-card p-4">
        <p className="text-2xl font-semibold">{formatCurrency(stats.totalCost)}</p>
        <p className="text-xs text-muted-foreground">סה״כ הוצאות</p>
      </div>
      <div className="glass-card p-4">
        <p className="text-2xl font-semibold">{formatCurrency(perDay)}</p>
        <p className="text-xs text-muted-foreground">ממוצע ליום</p>
      </div>
      <div className="glass-card p-4">
        <p className="text-2xl font-semibold">{stats.tripCount}</p>
        <p className="text-xs text-muted-foreground">טיולים</p>
      </div>
    </div>
  );
}

export function CountryPageClient({ iso }: { iso: string }) {
  const { data: country, isLoading } = useCountryByIso(iso);
  const { data: geojson } = useWorldCountriesGeoJson();

  const feature = geojson?.features.find((f) => f.properties.iso_a2 === iso.toUpperCase());
  const displayName = country?.name ?? feature?.properties.name ?? iso.toUpperCase();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 rounded-3xl" />
      </div>
    );
  }

  if (!country) {
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-semibold">{displayName}</h1>
        <CountryAddCard iso={iso} name={displayName} iso3={feature?.properties.iso_a3 ?? null} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="font-heading text-2xl font-semibold">{country.name}</h1>

      <Tabs defaultValue="overview">
        <div className="overflow-x-auto pb-1">
          <TabsList variant="line" className="w-max">
            {TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="pt-4">
          <CountryOverviewSection country={country} />
        </TabsContent>
        <TabsContent value="weather" className="pt-4">
          <PlaceholderSection
            title="מזג אוויר"
            description="תחזיות חיות יופיעו כאן לאחר חיבור ספק מזג אוויר."
            icon={CloudSun}
          />
        </TabsContent>
        <TabsContent value="cities" className="pt-4">
          <CountryCitiesSection countryId={country.id} />
        </TabsContent>
        <TabsContent value="hotels" className="pt-4">
          <PlacesSection
            countryId={country.id}
            kind="hotel"
            title="מלונות"
            emptyHint="לא נוספו מלונות עדיין. חברו את Google Places בהמשך לקבלת המלצות חיות."
          />
        </TabsContent>
        <TabsContent value="restaurants" className="pt-4">
          <PlacesSection
            countryId={country.id}
            kind="restaurant"
            title="מסעדות"
            emptyHint="לא נוספו מסעדות עדיין. חברו את Google Places בהמשך לקבלת המלצות חיות."
          />
        </TabsContent>
        <TabsContent value="transportation" className="pt-4">
          <PlaceholderSection
            title="תחבורה"
            description="טיפים והתמצאות בתחבורה יופיעו כאן בשלב מאוחר יותר."
            icon={Bus}
          />
        </TabsContent>
        <TabsContent value="budget" className="pt-4">
          <BudgetSection countryId={country.id} />
        </TabsContent>
        <TabsContent value="gallery" className="pt-4">
          <PhotoGallery countryId={country.id} />
        </TabsContent>
        <TabsContent value="timeline" className="pt-4">
          <CountryTimelineSection countryId={country.id} />
        </TabsContent>
        <TabsContent value="notes" className="pt-4">
          <CountryNotesSection country={country} />
        </TabsContent>
        <TabsContent value="ratings" className="pt-4">
          <CountryRatingsSection countryId={country.id} />
        </TabsContent>
        <TabsContent value="stats" className="pt-4">
          <CountryStatsSection countryId={country.id} />
        </TabsContent>
        <TabsContent value="ai" className="pt-4">
          <PlaceholderSection
            title="המלצות AI"
            description="הצעות מסלול טיול מותאמות אישית יופיעו כאן לאחר השקת מתכנן הטיולים ב-AI."
            icon={Bot}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
