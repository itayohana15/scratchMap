"use client";

import { ChevronLeft, Footprints } from "lucide-react";
import Link from "next/link";

import { CityExpensesSection } from "@/components/city/city-expenses-section";
import { CityMapSection } from "@/components/city/city-map-section";
import { CityNotesSection } from "@/components/city/city-notes-section";
import { CityOverviewSection } from "@/components/city/city-overview-section";
import { PhotoGallery } from "@/components/gallery/photo-gallery";
import { PlaceholderSection } from "@/components/shared/placeholder-section";
import { PlacesSection } from "@/components/shared/places-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCity } from "@/lib/queries/cities";

const TABS = [
  "overview",
  "map",
  "hotels",
  "restaurants",
  "attractions",
  "gallery",
  "notes",
  "expenses",
  "transportation",
  "walking",
] as const;

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  overview: "סקירה כללית",
  map: "מפה",
  hotels: "מלונות",
  restaurants: "מסעדות",
  attractions: "אטרקציות",
  gallery: "גלריה",
  notes: "הערות",
  expenses: "הוצאות",
  transportation: "תחבורה",
  walking: "מסלולי הליכה",
};

export function CityPageClient({ id }: { id: string }) {
  const { data: city, isLoading } = useCity(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 rounded-3xl" />
      </div>
    );
  }

  if (!city) {
    return (
      <div className="glass-panel px-6 py-14 text-center text-sm text-muted-foreground">
        העיר לא נמצאה.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        {city.countries && (
          <Link
            href={`/countries/${city.countries.iso_a2.toLowerCase()}`}
            className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-3.5 rotate-180" />
            {city.countries.name}
          </Link>
        )}
        <h1 className="font-heading text-2xl font-semibold">{city.name}</h1>
      </div>

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
          <CityOverviewSection city={city} />
        </TabsContent>
        <TabsContent value="map" className="pt-4">
          <CityMapSection latitude={city.latitude} longitude={city.longitude} status={city.status} />
        </TabsContent>
        <TabsContent value="hotels" className="pt-4">
          <PlacesSection
            cityId={city.id}
            kind="hotel"
            title="מלונות"
            emptyHint="לא נוספו מלונות עדיין. חברו את Google Places בהמשך לקבלת המלצות חיות."
          />
        </TabsContent>
        <TabsContent value="restaurants" className="pt-4">
          <PlacesSection
            cityId={city.id}
            kind="restaurant"
            title="מסעדות"
            emptyHint="לא נוספו מסעדות עדיין. חברו את Google Places בהמשך לקבלת המלצות חיות."
          />
        </TabsContent>
        <TabsContent value="attractions" className="pt-4">
          <PlacesSection
            cityId={city.id}
            kind="attraction"
            title="אטרקציות"
            emptyHint="לא נוספו אטרקציות עדיין. חברו את Google Places בהמשך לקבלת המלצות בקרבת מקום."
          />
        </TabsContent>
        <TabsContent value="gallery" className="pt-4">
          <PhotoGallery cityId={city.id} />
        </TabsContent>
        <TabsContent value="notes" className="pt-4">
          <CityNotesSection city={city} />
        </TabsContent>
        <TabsContent value="expenses" className="pt-4">
          <CityExpensesSection cityId={city.id} />
        </TabsContent>
        <TabsContent value="transportation" className="pt-4">
          <PlaceholderSection
            title="תחבורה"
            description="טיפים והתמצאות בתחבורה יופיעו כאן בשלב מאוחר יותר."
          />
        </TabsContent>
        <TabsContent value="walking" className="pt-4">
          <PlaceholderSection
            title="מסלולי הליכה"
            description="מסלולי הליכה מומלצים יופיעו כאן בשלב מאוחר יותר."
            icon={Footprints}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
