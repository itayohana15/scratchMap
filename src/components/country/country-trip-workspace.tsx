"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  BedDouble,
  Bot,
  CalendarDays,
  CircleCheck,
  DollarSign,
  Filter,
  ImagePlus,
  MapPin,
  NotebookPen,
  Plus,
  Route,
  Save,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { generateCountryAiItinerary } from "@/lib/ai/country-itinerary";
import { AttractionModal } from "@/components/country/attraction-modal";
import { CountryCitiesSection } from "@/components/country/country-cities-section";
import { CountryCurrencyConverter } from "@/components/country/country-currency-converter";
import { CountryNotesSection } from "@/components/country/country-notes-section";
import { CountryOverviewSection } from "@/components/country/country-overview-section";
import { CountryQuickFacts } from "@/components/country/country-quick-facts";
import { CountrySafetyInfo } from "@/components/country/country-safety-info";
import { CountryRatingsSection } from "@/components/country/country-ratings-section";
import { CountryStatsSection } from "@/components/country/country-stats-section";
import { CountryWeatherSection } from "@/components/country/country-weather-section";
import { useCountryMiniMap } from "@/components/country/use-country-mini-map";
import type { useCountryTripWorkspace } from "@/components/country/use-country-trip-workspace";
import { PhotoGallery } from "@/components/gallery/photo-gallery";
import { CountryAiRecommendations } from "@/components/shared/country-ai-recommendations";
import { PlacesSection } from "@/components/shared/places-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { usePlacesForCountry } from "@/lib/queries/places";
import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import type { CountryFeatureProperties } from "@/lib/map/geo";
import type { Tables } from "@/lib/supabase/types";
import {
  BOOKING_STATUS_LABELS,
  BOOKING_TYPE_LABELS,
  DAY_PART_LABELS,
  EXPENSE_CATEGORY_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  TRIP_STATUS_LABELS,
  buildMapLink,
  buildTripComparison,
  buildTripStatistics,
  createId,
  getTabOrderForStatus,
  type CountryTripWorkspaceState,
  type DayPart,
  type RecommendationCategory,
  type TripExpense,
  type TripItineraryDay,
  type TripItineraryItem,
  type TripPhase,
  type TripRecommendation,
  type TripWorkspaceTab,
} from "@/lib/trip-workspace";
import { formatCurrency, formatDate, formatDateRange } from "@/lib/format";
import { fetchCategoryRecommendations, useCategoryRecommendations } from "@/lib/places/country-places";
import { cn } from "@/lib/utils";

type WorkspaceController = ReturnType<typeof useCountryTripWorkspace>;

interface CountryTripWorkspaceContentProps {
  activeTab: TripWorkspaceTab;
  country: Tables<"countries">;
  iso: string;
  feature: Feature<Polygon | MultiPolygon, CountryFeatureProperties> | undefined;
  centerLat: number | undefined;
  centerLon: number | undefined;
  workspaceController: WorkspaceController;
}

const ALL_CATEGORIES = Object.keys(RECOMMENDATION_CATEGORY_LABELS) as RecommendationCategory[];
const API_RECOMMENDATION_COUNT = 10;
const SLOT_OPTIONS: DayPart[] = ["morning", "lunch", "afternoon", "dinner", "evening", "night"];

function createEmptyRecommendationDraft(): TripRecommendation {
  return {
    id: createId("saved-rec"),
    name: "",
    category: "attraction",
    location: "",
    shortDescription: "",
    estimatedDurationMinutes: 120,
    approximatePrice: null,
    openingHours: "",
    recommendedTimeOfDay: "morning",
    reservationRequired: false,
    mapLink: "",
    imageUrl: "",
    imageQuery: "",
    lat: null,
    lon: null,
    source: "manual",
    wikipediaUrl: null,
    website: null,
    wheelchairAccessible: null,
    isFree: null,
  };
}

function getRecommendationPriceLabel(category: RecommendationCategory) {
  switch (category) {
    case "restaurant":
    case "cafe":
      return "עלות ממוצעת";
    case "attraction":
    case "museum":
    case "nature":
    case "family":
    case "hidden_gem":
    case "day_trip":
    case "seasonal_event":
      return "מחיר כרטיס";
    case "hotel":
      return "מחיר ללילה";
    case "transportation":
      return "עלות נסיעה";
    default:
      return "עלות משוערת";
  }
}

export function RecommendationImage({
  recommendation,
  className,
  imageClassName,
}: {
  recommendation: TripRecommendation;
  className?: string;
  imageClassName?: string;
}) {
  const [src, setSrc] = useState(recommendation.imageUrl);

  useEffect(() => {
    setSrc(recommendation.imageUrl);
  }, [recommendation.id, recommendation.imageUrl]);

  useEffect(() => {
    if (src || !recommendation.imageQuery) return;
    let cancelled = false;
    fetch(`/api/places/photo?q=${encodeURIComponent(recommendation.imageQuery)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { photoUrl?: string | null } | null) => {
        if (!cancelled && data?.photoUrl) {
          setSrc(data.photoUrl);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [recommendation.imageQuery, src]);

  return src ? (
    <div className={cn("h-32 w-full overflow-hidden rounded-xl shadow-sm", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={recommendation.name}
        className={cn(
          "h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105",
          imageClassName
        )}
      />
    </div>
  ) : (
    <div
      className={cn(
        "flex h-32 w-full items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 via-primary/8 to-transparent text-xs text-muted-foreground",
        className
      )}
    >
      תמונה תיטען אוטומטית
    </div>
  );
}

function markerColor(category: RecommendationCategory) {
  switch (category) {
    case "restaurant":
    case "cafe":
      return "#f97316";
    case "hotel":
      return "#0ea5e9";
    case "museum":
      return "#8b5cf6";
    case "nature":
      return "#22c55e";
    case "nightlife":
      return "#ec4899";
    case "transportation":
      return "#64748b";
    default:
      return "#e11d48";
  }
}

function toRecommendationFromPlace(
  place: Tables<"places">,
  fallbackCategory?: RecommendationCategory
): TripRecommendation {
  const category =
    fallbackCategory ??
    (place.kind === "hotel"
      ? "hotel"
      : place.kind === "restaurant"
        ? "restaurant"
        : "attraction");

  return {
    id: `db-${place.id}`,
    name: place.name,
    category,
    location: place.address ?? "",
    shortDescription: place.notes ?? "",
    estimatedDurationMinutes: category === "restaurant" ? 75 : 120,
    approximatePrice: null,
    openingHours: "",
    recommendedTimeOfDay:
      category === "restaurant" ? "dinner" : category === "cafe" ? "lunch" : "morning",
    reservationRequired: false,
    mapLink: buildMapLink(place.name, place.latitude, place.longitude),
    imageUrl: "",
    imageQuery: place.name,
    lat: place.latitude,
    lon: place.longitude,
    source: "database",
    wikipediaUrl: null,
    website: null,
    wheelchairAccessible: null,
    isFree: null,
  };
}

function buildLiveRecommendations(
  workspace: CountryTripWorkspaceState,
  apiRecommendations: TripRecommendation[] | undefined,
  attractionPlaces: Tables<"places">[] | undefined,
  restaurantPlaces: Tables<"places">[] | undefined,
  hotelPlaces: Tables<"places">[] | undefined
) {
  const fromDb = [
    ...(attractionPlaces ?? []).map((place) => toRecommendationFromPlace(place, "attraction")),
    ...(restaurantPlaces ?? []).map((place) => toRecommendationFromPlace(place, "restaurant")),
    ...(hotelPlaces ?? []).map((place) => toRecommendationFromPlace(place, "hotel")),
  ];

  const merged = [...workspace.recommendations, ...(apiRecommendations ?? []), ...fromDb];
  const seen = new Map<string, TripRecommendation>();
  for (const recommendation of merged) {
    const key = `${recommendation.name.toLowerCase()}::${recommendation.location.toLowerCase()}`;
    if (!seen.has(key) || seen.get(key)?.source === "api") {
      seen.set(key, recommendation);
    }
  }
  return [...seen.values()];
}

function findTodayDay(workspace: CountryTripWorkspaceState) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    workspace.itineraryDays.find((day) => day.date === today) ??
    workspace.itineraryDays.find((day) => day.items.some((item) => !item.completed && !item.skipped)) ??
    workspace.itineraryDays[0] ??
    null
  );
}

function nextActivity(day: TripItineraryDay | null) {
  return day?.items.find((item) => !item.completed && !item.skipped) ?? null;
}

function journalForDay(workspace: CountryTripWorkspaceState, dayId: string) {
  return workspace.journalEntries.find((entry) => entry.dayId === dayId) ?? null;
}

function plannedVsActualBadge(item: TripItineraryItem) {
  if (item.completed) return <Badge variant="secondary">בוצע</Badge>;
  if (item.skipped) return <Badge variant="outline">דולג</Badge>;
  if (item.optional) return <Badge variant="outline">אופציונלי</Badge>;
  return <Badge variant="outline">מתוכנן</Badge>;
}

function SmartPlanningInsights({
  days,
  recommendations,
}: {
  days: TripItineraryDay[];
  recommendations: TripRecommendation[];
}) {
  const insights = useMemo(() => {
    return days.flatMap((day) => {
      const warnings: string[] = [];
      const totalMinutes = day.items.reduce(
        (sum, item) => sum + (item.estimatedDurationMinutes ?? 90) + (item.travelMinutes ?? 0),
        0
      );
      if (day.items.length > 5 || totalMinutes > 540) {
        warnings.push(`${day.title} עמוס יחסית. כדאי להזיז פעילות אחת ליום אחר.`);
      }
      if (day.items.some((item) => item.openingHours.toLowerCase().includes("סגור"))) {
        warnings.push(`${day.title} כולל מקום עם אזהרת שעות פתיחה.`);
      }
      const restaurantSuggestion = recommendations.find(
        (recommendation) =>
          (recommendation.category === "restaurant" || recommendation.category === "cafe") &&
          day.items.every((item) => item.name !== recommendation.name)
      );
      if (restaurantSuggestion) {
        warnings.push(`הוסיפו גם עצירת אוכל קרובה כמו ${restaurantSuggestion.name}.`);
      }
      return warnings;
    });
  }, [days, recommendations]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <h3 className="font-heading text-lg font-semibold">תכנון מסלול חכם</h3>
      </div>
      {insights.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {insights.map((insight) => (
            <div key={insight} className="section-card flex items-start gap-3 p-4 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <p>{insight}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="section-card p-4 text-sm text-muted-foreground">
          המסלול נראה מאוזן כרגע. ככל שתוסיפו עוד עצירות נציג כאן המלצות על סדר, עומס ומסעדות קרובות.
        </div>
      )}
    </section>
  );
}

function MapFilterChips({
  selected,
  onToggle,
}: {
  selected: RecommendationCategory[];
  onToggle: (category: RecommendationCategory) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {ALL_CATEGORIES.map((category) => {
        const active = selected.includes(category);
        return (
          <button
            key={category}
            type="button"
            onClick={() => onToggle(category)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted"
            )}
          >
            {RECOMMENDATION_CATEGORY_LABELS[category]}
          </button>
        );
      })}
    </div>
  );
}

function TripPlannerMap({
  feature,
  days,
  recommendations,
  selectedDayId,
  activeFilters,
  onToggleFilter,
  onAddToDay,
  onRemoveFromItinerary,
}: {
  feature: Feature<Polygon | MultiPolygon, CountryFeatureProperties> | undefined;
  days: TripItineraryDay[];
  recommendations: TripRecommendation[];
  selectedDayId: string;
  activeFilters: RecommendationCategory[];
  onToggleFilter: (category: RecommendationCategory) => void;
  onAddToDay: (recommendation: TripRecommendation) => void;
  onRemoveFromItinerary: (dayId: string, itemId: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { containerRef, mapRef, ready } = useCountryMiniMap({ isDark, feature });
  const markersRef = useRef<Array<{ remove: () => void }>>([]);
  const routeReadyRef = useRef(false);
  const selectedDay = days.find((day) => day.id === selectedDayId) ?? days[0] ?? null;

  const visibleRecommendations = useMemo(
    () =>
      recommendations.filter(
        (recommendation) =>
          recommendation.lat != null &&
          recommendation.lon != null &&
          activeFilters.includes(recommendation.category)
      ),
    [activeFilters, recommendations]
  );

  const routeItems = useMemo(
    () => selectedDay?.items.filter((item) => item.lat != null && item.lon != null) ?? [],
    [selectedDay]
  );

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    let cancelled = false;

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled || !mapRef.current) return;

      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];

      for (const recommendation of visibleRecommendations) {
        const markerNode = document.createElement("button");
        markerNode.type = "button";
        markerNode.className =
          "flex size-6 items-center justify-center rounded-full border-2 border-white shadow-lg";
        markerNode.style.backgroundColor = markerColor(recommendation.category);
        markerNode.innerHTML = `<span style="color:white;font-size:10px">+</span>`;

        const popupNode = document.createElement("div");
        popupNode.className = "w-52 space-y-2 p-1 text-sm";
        popupNode.innerHTML = `
          <p class="font-medium">${recommendation.name}</p>
          <p class="text-xs text-slate-500">${RECOMMENDATION_CATEGORY_LABELS[recommendation.category]}</p>
          <p class="text-xs text-slate-500">${recommendation.location || ""}</p>
        `;
        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.className =
          "w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground";
        addButton.textContent = "הוספה למסלול";
        addButton.addEventListener("click", () => onAddToDay(recommendation));
        popupNode.appendChild(addButton);

        const popup = new maplibregl.Popup({ offset: 12 }).setDOMContent(popupNode);

        const marker = new maplibregl.Marker({ element: markerNode })
          .setLngLat([recommendation.lon!, recommendation.lat!])
          .setPopup(popup)
          .addTo(mapRef.current);

        markersRef.current.push(marker);
      }

      for (const item of routeItems) {
        const markerNode = document.createElement("button");
        markerNode.type = "button";
        markerNode.className =
          "flex size-7 items-center justify-center rounded-full border-2 border-white bg-slate-900 text-[11px] font-semibold text-white shadow-lg";
        markerNode.textContent = String(routeItems.indexOf(item) + 1);

        const popupNode = document.createElement("div");
        popupNode.className = "w-48 space-y-2 p-1 text-sm";
        popupNode.innerHTML = `
          <p class="font-medium">${item.name}</p>
          <p class="text-xs text-slate-500">${DAY_PART_LABELS[item.slot]}${item.plannedStartTime ? ` · ${item.plannedStartTime}` : ""}</p>
          <p class="text-xs text-slate-500">${item.location || ""}</p>
        `;
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className =
          "w-full rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700";
        removeButton.textContent = "הסרה מהיום";
        removeButton.addEventListener("click", () => onRemoveFromItinerary(selectedDayId, item.id));
        popupNode.appendChild(removeButton);

        const popup = new maplibregl.Popup({ offset: 12 }).setDOMContent(popupNode);
        const marker = new maplibregl.Marker({ element: markerNode })
          .setLngLat([item.lon!, item.lat!])
          .setPopup(popup)
          .addTo(mapRef.current);
        markersRef.current.push(marker);
      }
    });

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
    };
  }, [mapRef, onAddToDay, onRemoveFromItinerary, ready, routeItems, selectedDayId, visibleRecommendations]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const sourceId = "trip-route";
    const layerId = "trip-route-line";

    const routeGeoJson = {
      type: "FeatureCollection" as const,
      features:
        routeItems.length > 1
          ? [
              {
                type: "Feature" as const,
                geometry: {
                  type: "LineString" as const,
                  coordinates: routeItems.map((item) => [item.lon!, item.lat!]),
                },
                properties: {},
              },
            ]
          : [],
    };

    if (!routeReadyRef.current) {
      map.once("styledata", () => {
        routeReadyRef.current = false;
      });
    }

    const draw = () => {
      const existingSource = map.getSource(sourceId) as { setData?: (data: unknown) => void } | undefined;
      if (existingSource?.setData) {
        existingSource.setData(routeGeoJson);
        return;
      }

      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: "geojson", data: routeGeoJson });
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: "line",
          source: sourceId,
          paint: {
            "line-color": "#0f172a",
            "line-width": 3,
            "line-opacity": 0.75,
          },
        });
      }
      routeReadyRef.current = true;
    };

    if (map.isStyleLoaded()) {
      draw();
    } else {
      map.once("load", draw);
    }
  }, [mapRef, ready, routeItems]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold">מפת תכנון וניווט</h3>
          <p className="text-sm text-muted-foreground">
            סמנו קטגוריות, פתחו markers והוסיפו משם עצירות ליום הפעיל.
          </p>
        </div>
        <div className="sm:hidden">
          <Sheet>
            <SheetTrigger
              render={
                <Button variant="outline" size="sm" className="gap-1.5" />
              }
            >
              <Filter className="size-4" />
              פילטרים
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-3xl">
              <SheetHeader>
                <SheetTitle>פילטרי מפה</SheetTitle>
                <SheetDescription>בחרו אילו קטגוריות להציג על גבי המפה.</SheetDescription>
              </SheetHeader>
              <div className="p-4">
                <MapFilterChips selected={activeFilters} onToggle={onToggleFilter} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <div className="hidden sm:block">
        <MapFilterChips selected={activeFilters} onToggle={onToggleFilter} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_360px]">
        <div className="relative min-h-[24rem] overflow-hidden rounded-3xl border border-border">
          {!ready && <Skeleton className="absolute inset-0 rounded-3xl" />}
          <div ref={containerRef} className="h-[26rem] w-full" />
        </div>

        <div className="space-y-3">
          <div className="section-card p-4">
            <p className="text-sm font-medium">יום מוצג במפה</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {selectedDay?.title ?? "אין יום נבחר"}{" "}
              {selectedDay?.date ? `· ${formatDate(selectedDay.date)}` : ""}
            </p>
          </div>

          <div className="section-card space-y-3 p-4">
            <div className="flex items-center gap-2">
              <Route className="size-4 text-primary" />
              <p className="font-medium">מסלול יומי</p>
            </div>
            {routeItems.length > 0 ? (
              <ol className="space-y-2">
                {routeItems.map((item, index) => (
                  <li key={item.id} className="rounded-2xl border border-border/70 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">
                        {index + 1}. {item.name}
                      </span>
                      {plannedVsActualBadge(item)}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {DAY_PART_LABELS[item.slot]}
                      {item.plannedStartTime ? ` · ${item.plannedStartTime}` : ""}
                      {item.travelMinutes != null ? ` · ${item.travelMinutes} דק' נסיעה` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                הוסיפו עצירות ליום הנבחר כדי לראות route על המפה.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionShell({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-500 sm:space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
          {description && (
            <p className="mt-2 max-w-2xl text-base leading-[1.8] text-muted-foreground sm:text-lg">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function PreferenceField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ExpenseTable({
  title,
  bucket,
  expenses,
  dayOptions,
  onAdd,
  onChange,
  onRemove,
}: {
  title: string;
  bucket: "estimatedExpenses" | "actualExpenses";
  expenses: TripExpense[];
  dayOptions: TripItineraryDay[];
  onAdd: () => void;
  onChange: (expenseId: string, patch: Partial<TripExpense>) => void;
  onRemove: (expenseId: string) => void;
}) {
  return (
    <div className="section-card space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={onAdd}>
          <Plus className="size-4" />
          הוספה
        </Button>
      </div>
      {expenses.length > 0 ? (
        <div className="space-y-3">
          {expenses.map((expense) => (
            <div key={expense.id} className="grid gap-2 rounded-2xl border border-border/70 p-3 lg:grid-cols-6">
              <Input
                value={expense.label}
                onChange={(event) => onChange(expense.id, { label: event.target.value })}
                placeholder="כותרת"
              />
              <Select
                value={expense.category}
                onValueChange={(value) =>
                  onChange(expense.id, {
                    category: value as TripExpense["category"],
                  })
                }
              >
                <SelectTrigger size="sm">
                  <span>{EXPENSE_CATEGORY_LABELS[expense.category]}</span>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXPENSE_CATEGORY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={expense.amount || ""}
                onChange={(event) =>
                  onChange(expense.id, {
                    amount: Number(event.target.value) || 0,
                  })
                }
                placeholder="סכום"
                type="number"
              />
              <Input
                value={expense.date}
                onChange={(event) => onChange(expense.id, { date: event.target.value })}
                type="date"
              />
              <Select
                value={expense.dayId ?? "none"}
                onValueChange={(value) =>
                  onChange(expense.id, { dayId: value === "none" ? null : value })
                }
              >
                <SelectTrigger size="sm">
                  <span>
                    {expense.dayId
                      ? dayOptions.find((day) => day.id === expense.dayId)?.title ?? "יום"
                      : "ללא יום"}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">ללא יום</SelectItem>
                  {dayOptions.map((day) => (
                    <SelectItem key={day.id} value={day.id}>
                      {day.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Input
                  value={expense.notes}
                  onChange={(event) => onChange(expense.id, { notes: event.target.value })}
                  placeholder={bucket === "estimatedExpenses" ? "הערת תקציב" : "הערה בפועל"}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(expense.id)}
                  aria-label="מחיקת שורה"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">עדיין אין שורות תקציב בקטגוריה הזו.</p>
      )}
    </div>
  );
}

export function CountryTripWorkspaceContent({
  activeTab,
  country,
  iso,
  feature,
  centerLat,
  centerLon,
  workspaceController,
}: CountryTripWorkspaceContentProps) {
  const { workspace, actions, hydrated } = workspaceController;
  const { data: attractionPlaces } = usePlacesForCountry(country.id, "attraction");
  const { data: restaurantPlaces } = usePlacesForCountry(country.id, "restaurant");
  const { data: hotelPlaces } = usePlacesForCountry(country.id, "hotel");
  const [selectedDayId, setSelectedDayId] = useState(workspace.itineraryDays[0]?.id ?? "");
  const [activeRecommendationCategory, setActiveRecommendationCategory] =
    useState<RecommendationCategory>("attraction");
  const [apiRecommendationsByCategory, setApiRecommendationsByCategory] = useState<
    Partial<Record<RecommendationCategory, TripRecommendation[]>>
  >({});
  const [shouldWarmAllRecommendationCategories, setShouldWarmAllRecommendationCategories] =
    useState(activeTab === "map" || activeTab === "recommendations");
  const {
    data: currentCategoryResult,
    isLoading: currentCategoryLoading,
    isFetching: currentCategoryFetching,
  } = useCategoryRecommendations(
    iso,
    activeRecommendationCategory,
    API_RECOMMENDATION_COUNT,
    workspace.preferences.startDate,
    workspace.preferences.endDate
  );
  const currentCategoryRecommendations = currentCategoryResult?.places;
  const currentCategoryMeta = currentCategoryResult?.meta;

  const liveRecommendations = useMemo(
    () =>
      buildLiveRecommendations(
        workspace,
        Object.values(apiRecommendationsByCategory).flat(),
        attractionPlaces,
        restaurantPlaces,
        hotelPlaces
      ),
    [apiRecommendationsByCategory, attractionPlaces, hotelPlaces, restaurantPlaces, workspace]
  );

  const [mapFilters, setMapFilters] = useState<RecommendationCategory[]>(ALL_CATEGORIES);
  const [selectedRecommendation, setSelectedRecommendation] = useState<TripRecommendation | null>(
    null
  );
  const [recommendationDialogOpen, setRecommendationDialogOpen] = useState(false);
  const [recommendationDraft, setRecommendationDraft] =
    useState<TripRecommendation>(createEmptyRecommendationDraft);

  useEffect(() => {
    if (!workspace.itineraryDays.some((day) => day.id === selectedDayId)) {
      setSelectedDayId(workspace.itineraryDays[0]?.id ?? "");
    }
  }, [selectedDayId, workspace.itineraryDays]);

  useEffect(() => {
    if (activeTab === "map" || activeTab === "recommendations") {
      setShouldWarmAllRecommendationCategories(true);
    }
  }, [activeTab]);

  useEffect(() => {
    setApiRecommendationsByCategory({});
  }, [iso, workspace.preferences.endDate, workspace.preferences.startDate]);

  useEffect(() => {
    if (!currentCategoryRecommendations) return;
    setApiRecommendationsByCategory((current) => ({
      ...current,
      [activeRecommendationCategory]: currentCategoryRecommendations,
    }));
  }, [activeRecommendationCategory, currentCategoryRecommendations]);

  useEffect(() => {
    if (!shouldWarmAllRecommendationCategories || !iso) return;

    const categoriesToWarm = ALL_CATEGORIES.filter(
      (category) =>
        category !== activeRecommendationCategory && !apiRecommendationsByCategory[category]
    );
    if (categoriesToWarm.length === 0) return;

    let cancelled = false;

    Promise.allSettled(
      categoriesToWarm.map(async (category) => {
        const result = await fetchCategoryRecommendations(
          iso,
          category,
          API_RECOMMENDATION_COUNT,
          workspace.preferences.startDate || undefined,
          workspace.preferences.endDate || undefined
        );
        return [category, result.places] as const;
      })
    ).then((results) => {
      if (cancelled) return;

      setApiRecommendationsByCategory((current) => {
        let changed = false;
        const next = { ...current };

        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const [category, recommendations] = result.value;
          if (next[category] !== recommendations) {
            next[category] = recommendations;
            changed = true;
          }
        }

        return changed ? next : current;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeRecommendationCategory,
    apiRecommendationsByCategory,
    iso,
    shouldWarmAllRecommendationCategories,
    workspace.preferences.endDate,
    workspace.preferences.startDate,
  ]);

  const todayDay = findTodayDay(workspace);
  const nextPlannedActivity = nextActivity(todayDay);
  const selectedDay =
    workspace.itineraryDays.find((day) => day.id === selectedDayId) ?? workspace.itineraryDays[0];
  const filteredRecommendations = liveRecommendations.filter(
    (recommendation) => recommendation.category === activeRecommendationCategory
  );
  const activeRecommendationDetails = useMemo(() => {
    if (!selectedRecommendation) return null;
    return (
      liveRecommendations.find(
        (recommendation) =>
          recommendation.id === selectedRecommendation.id ||
          (recommendation.name === selectedRecommendation.name &&
            recommendation.location === selectedRecommendation.location)
      ) ?? selectedRecommendation
    );
  }, [liveRecommendations, selectedRecommendation]);
  const budgetComparison = buildTripComparison(workspace);
  const tripStatistics = buildTripStatistics(workspace);
  const activeTabOrder = getTabOrderForStatus(workspace.tripStatus);

  async function handleAiPlan() {
    try {
      const response = await generateCountryAiItinerary({
        countryName: country.name,
        isoA2: iso.toUpperCase(),
        tripStatus: workspace.tripStatus,
        preferences: workspace.preferences,
        selectedPlaces: workspace.recommendations,
        recommendations: liveRecommendations,
        existingDays: workspace.itineraryDays,
      });
      actions.replaceWithAiPlan(response);
      toast.success("נבנה מסלול יום-אחר-יום");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "בניית המסלול נכשלה");
    }
  }

  function toggleMapFilter(category: RecommendationCategory) {
    setMapFilters((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category]
    );
  }

  function submitRecommendationDraft() {
    if (!recommendationDraft.name.trim()) {
      toast.error("צריך לפחות שם להמלצה");
      return;
    }

    const normalized: TripRecommendation = {
      ...recommendationDraft,
      id: createId("saved-rec"),
      name: recommendationDraft.name.trim(),
      imageQuery: recommendationDraft.imageQuery || recommendationDraft.name.trim(),
      mapLink:
        recommendationDraft.mapLink ||
        buildMapLink(
          recommendationDraft.name.trim(),
          recommendationDraft.lat,
          recommendationDraft.lon
        ),
    };
    actions.addOrUpdateRecommendation(normalized);
    setRecommendationDraft(createEmptyRecommendationDraft());
    setRecommendationDialogOpen(false);
    toast.success("המלצה נשמרה ל-workspace");
  }

  if (!hydrated) {
    return <Skeleton className="h-[32rem] rounded-[2rem]" />;
  }

  return (
    <>
      <TabsContent value="overview" className={cn("pt-0", activeTab !== "overview" && "hidden")}>
        <div className="animate-in fade-in slide-in-from-bottom-2 mb-8 duration-500">
          <CountryQuickFacts isoA2={iso} />
        </div>

        <SectionShell
          title="Trip overview"
          description="העמוד משנה דגש לפי מצב הטיול, אבל כל התכנון, היומן והסיכום נשמרים יחד באותו חלל עבודה."
          action={
            <Select
              value={workspace.tripStatus}
              onValueChange={(value) => actions.setTripStatus(value as TripPhase)}
            >
              <SelectTrigger size="sm" className="w-44">
                <span>{TRIP_STATUS_LABELS[workspace.tripStatus]}</span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TRIP_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_360px]">
            <div className="space-y-4">
              <div className="section-card grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                <PreferenceField label="תאריכי נסיעה">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="date"
                      value={workspace.preferences.startDate}
                      onChange={(event) =>
                        actions.updatePreferences({ startDate: event.target.value })
                      }
                    />
                    <Input
                      type="date"
                      value={workspace.preferences.endDate}
                      onChange={(event) =>
                        actions.updatePreferences({ endDate: event.target.value })
                      }
                    />
                  </div>
                </PreferenceField>
                <PreferenceField label="מספר נוסעים">
                  <Input
                    type="number"
                    value={workspace.preferences.travelers}
                    onChange={(event) =>
                      actions.updatePreferences({
                        travelers: Number(event.target.value) || 1,
                      })
                    }
                  />
                </PreferenceField>
                <PreferenceField label="תקציב משוער">
                  <Input
                    type="number"
                    value={workspace.preferences.budget ?? ""}
                    onChange={(event) =>
                      actions.updatePreferences({
                        budget: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                    placeholder="למשל 8500"
                  />
                </PreferenceField>
                <PreferenceField label="Trip style">
                  <Input
                    value={workspace.preferences.tripStyle}
                    onChange={(event) =>
                      actions.updatePreferences({ tripStyle: event.target.value })
                    }
                    placeholder="רומנטי, עירוני, קולינרי..."
                  />
                </PreferenceField>
                <PreferenceField label="קצב">
                  <Select
                    value={workspace.preferences.tripPace}
                    onValueChange={(value) =>
                      actions.updatePreferences({
                        tripPace: value as CountryTripWorkspaceState["preferences"]["tripPace"],
                      })
                    }
                  >
                    <SelectTrigger size="sm">
                      <span>
                        {workspace.preferences.tripPace === "relaxed"
                          ? "רגוע"
                          : workspace.preferences.tripPace === "balanced"
                            ? "מאוזן"
                            : "אינטנסיבי"}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relaxed">רגוע</SelectItem>
                      <SelectItem value="balanced">מאוזן</SelectItem>
                      <SelectItem value="fast">אינטנסיבי</SelectItem>
                    </SelectContent>
                  </Select>
                </PreferenceField>
                <PreferenceField label="תחבורה מועדפת">
                  <Input
                    value={workspace.preferences.transportationPreferences}
                    onChange={(event) =>
                      actions.updatePreferences({
                        transportationPreferences: event.target.value,
                      })
                    }
                    placeholder="רכב, רכבת, הליכה..."
                  />
                </PreferenceField>
                <PreferenceField label="תחומי עניין">
                  <Input
                    value={workspace.preferences.interests}
                    onChange={(event) =>
                      actions.updatePreferences({ interests: event.target.value })
                    }
                    placeholder="היסטוריה, שווקים, חופים..."
                  />
                </PreferenceField>
                <PreferenceField label="אזור לינה">
                  <Input
                    value={workspace.preferences.accommodationArea}
                    onChange={(event) =>
                      actions.updatePreferences({
                        accommodationArea: event.target.value,
                      })
                    }
                  />
                </PreferenceField>
                <PreferenceField label="העדפות תזונתיות ונגישות">
                  <div className="grid gap-2">
                    <Input
                      value={workspace.preferences.dietaryPreferences}
                      onChange={(event) =>
                        actions.updatePreferences({
                          dietaryPreferences: event.target.value,
                        })
                      }
                      placeholder="צמחוני, ללא גלוטן..."
                    />
                    <Input
                      value={workspace.preferences.accessibilityNeeds}
                      onChange={(event) =>
                        actions.updatePreferences({
                          accessibilityNeeds: event.target.value,
                        })
                      }
                      placeholder="מעליות, הליכה קצרה..."
                    />
                  </div>
                </PreferenceField>
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">חלון נסיעה</p>
                  <p className="mt-2 text-lg font-semibold">
                    {formatDateRange(
                      workspace.preferences.startDate || null,
                      workspace.preferences.endDate || null
                    ) ?? "עוד לא הוגדר"}
                  </p>
                </div>
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">ימים במסלול</p>
                  <p className="mt-2 text-lg font-semibold">{workspace.itineraryDays.length}</p>
                </div>
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">המלצות פעילות</p>
                  <p className="mt-2 text-lg font-semibold">{liveRecommendations.length}</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {workspace.tripStatus === "currently_traveling" ? (
                <div className="section-card space-y-4 p-4">
                  <div className="flex items-center gap-2">
                    <Route className="size-4 text-primary" />
                    <h3 className="font-medium">המסלול של היום</h3>
                  </div>
                  {todayDay ? (
                    <>
                      <div className="rounded-2xl border border-border/70 p-3">
                        <p className="text-sm font-medium">
                          {todayDay.title}
                          {todayDay.date ? ` · ${formatDate(todayDay.date)}` : ""}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {todayDay.items.length} עצירות מתוכננות
                        </p>
                      </div>
                      {nextPlannedActivity ? (
                        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-3">
                          <p className="text-sm font-medium">הפעילות הבאה</p>
                          <p className="mt-1 text-lg font-semibold">{nextPlannedActivity.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {DAY_PART_LABELS[nextPlannedActivity.slot]}
                            {nextPlannedActivity.plannedStartTime
                              ? ` · ${nextPlannedActivity.plannedStartTime}`
                              : ""}
                            {nextPlannedActivity.travelMinutes != null
                              ? ` · ${nextPlannedActivity.travelMinutes} דק' נסיעה`
                              : ""}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              className="gap-1.5"
                              onClick={() =>
                                actions.updateItem(todayDay.id, nextPlannedActivity.id, {
                                  completed: true,
                                  skipped: false,
                                })
                              }
                            >
                              <CircleCheck className="size-4" />
                              סמן כהושלם
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                actions.updateItem(todayDay.id, nextPlannedActivity.id, {
                                  skipped: true,
                                  completed: false,
                                })
                              }
                            >
                              דלג
                            </Button>
                            {nextPlannedActivity.mapLink && (
                              <Button
                                size="sm"
                                variant="secondary"
                                nativeButton={false}
                                render={
                                  <a
                                    href={nextPlannedActivity.mapLink}
                                    target="_blank"
                                    rel="noreferrer"
                                  />
                                }
                              >
                                ניווט במפה
                              </Button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          כל פעילויות היום כבר טופלו. אפשר לעדכן יומן, הוצאות או להוסיף עצירה ספונטנית.
                        </p>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Button
                          variant="secondary"
                          className="gap-1.5"
                          onClick={() => actions.addItem(todayDay.id, "afternoon")}
                        >
                          <Plus className="size-4" />
                          מקום ספונטני
                        </Button>
                        <Button
                          variant="outline"
                          className="gap-1.5"
                          onClick={() =>
                            actions.addExpense("actualExpenses", {
                              dayId: todayDay.id,
                              date: todayDay.date,
                            })
                          }
                        >
                          <DollarSign className="size-4" />
                          הוצאה יומית
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      אין עדיין ימים במסלול. אפשר ליצור יום חדש או לבנות מסלול עם AI.
                    </p>
                  )}
                </div>
              ) : workspace.tripStatus === "completed" ? (
                <div className="section-card space-y-4 p-4">
                  <div className="flex items-center gap-2">
                    <Star className="size-4 text-amber-500" />
                    <h3 className="font-medium">סיכום מהיר</h3>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 p-3">
                      <p className="text-xs text-muted-foreground">זיכרון אהוב</p>
                      <p className="mt-1 text-sm">{workspace.summary.favoriteMemory || country.favorite_memory || "—"}</p>
                    </div>
                    <div className="rounded-2xl border border-border/70 p-3">
                      <p className="text-xs text-muted-foreground">המקום האהוב</p>
                      <p className="mt-1 text-sm">{workspace.summary.favoritePlace || "—"}</p>
                    </div>
                    <div className="rounded-2xl border border-border/70 p-3">
                      <p className="text-xs text-muted-foreground">יחס תכנון מול ביצוע</p>
                      <p className="mt-1 text-sm">
                        {tripStatistics.completedActivities}/{tripStatistics.plannedActivities} פעילויות הושלמו
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 p-3">
                      <p className="text-xs text-muted-foreground">הוצאה בפועל</p>
                      <p className="mt-1 text-sm">{formatCurrency(tripStatistics.totalActualExpenses)}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="section-card space-y-4 p-4">
                  <div className="flex items-center gap-2">
                    <Bot className="size-4 text-primary" />
                    <h3 className="font-medium">Planning first</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    במצב {TRIP_STATUS_LABELS[workspace.tripStatus]} אנחנו מדגישים קודם את כלי התכנון: העדפות, AI, מסלול, מפה והמלצות.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Button className="gap-1.5" onClick={handleAiPlan}>
                      <Sparkles className="size-4" />
                      Create itinerary with AI
                    </Button>
                    <Button
                      variant="secondary"
                      className="gap-1.5"
                      onClick={() =>
                        actions.addDay(
                          selectedDay?.date || workspace.preferences.startDate || ""
                        )
                      }
                    >
                      <Plus className="size-4" />
                      הוספת יום
                    </Button>
                  </div>
                  {workspace.lastAiPlanSummary && (
                    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 text-sm">
                      {workspace.lastAiPlanSummary}
                    </div>
                  )}
                </div>
              )}

              <div className="section-card p-4">
                <p className="text-sm font-medium">מיקוד הטאבים לפי מצב הטיול</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {activeTabOrder.map((tab) => (
                    <Badge key={tab} variant={tab === activeTab ? "default" : "outline"}>
                      {tab}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="plan" className={cn("pt-0", activeTab !== "plan" && "hidden")}>
        <SectionShell
          title="תכנון חכם"
          description="העדפות הטיול, AI itinerary, הזמנות ותובנות route נבנים כאן יחד."
          action={
            <Button className="gap-1.5" onClick={handleAiPlan}>
              <Sparkles className="size-4" />
              Create itinerary with AI
            </Button>
          }
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_380px]">
            <div className="space-y-4">
              <SmartPlanningInsights days={workspace.itineraryDays} recommendations={liveRecommendations} />
              <div className="section-card space-y-4 p-4">
                <div className="flex items-center gap-2">
                  <BedDouble className="size-4 text-primary" />
                  <h3 className="font-medium">הזמנות ו-bookings</h3>
                </div>
                {workspace.bookings.length > 0 ? (
                  <div className="space-y-3">
                    {workspace.bookings.map((booking) => (
                      <div key={booking.id} className="grid gap-2 rounded-2xl border border-border/70 p-3 md:grid-cols-6">
                        <Input
                          value={booking.name}
                          onChange={(event) =>
                            actions.upsertBooking({ ...booking, name: event.target.value })
                          }
                          placeholder="שם הזמנה"
                        />
                        <Select
                          value={booking.type}
                          onValueChange={(value) =>
                            actions.upsertBooking({
                              ...booking,
                              type: value as typeof booking.type,
                            })
                          }
                        >
                          <SelectTrigger size="sm">
                            <span>{BOOKING_TYPE_LABELS[booking.type]}</span>
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(BOOKING_TYPE_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          type="date"
                          value={booking.date}
                          onChange={(event) =>
                            actions.upsertBooking({ ...booking, date: event.target.value })
                          }
                        />
                        <Input
                          type="time"
                          value={booking.time}
                          onChange={(event) =>
                            actions.upsertBooking({ ...booking, time: event.target.value })
                          }
                        />
                        <Select
                          value={booking.status}
                          onValueChange={(value) =>
                            actions.upsertBooking({
                              ...booking,
                              status: value as typeof booking.status,
                            })
                          }
                        >
                          <SelectTrigger size="sm">
                            <span>{BOOKING_STATUS_LABELS[booking.status]}</span>
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(BOOKING_STATUS_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex gap-2">
                          <Input
                            value={booking.reference}
                            onChange={(event) =>
                              actions.upsertBooking({
                                ...booking,
                                reference: event.target.value,
                              })
                            }
                            placeholder="מספר הזמנה"
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => actions.removeBooking(booking.id)}
                            aria-label="מחיקת הזמנה"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    עדיין אין bookings. אפשר להוסיף טיסות, מלונות, מסעדות ותחבורה.
                  </p>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => actions.upsertBooking(actions.createBooking())}
                >
                  <Plus className="size-4" />
                  הוספת booking
                </Button>
              </div>
            </div>

            <div className="section-card space-y-4 p-4">
              <div className="flex items-center gap-2">
                <Save className="size-4 text-primary" />
                <h3 className="font-medium">מיקוד תכנוני</h3>
              </div>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>סטטוס: {TRIP_STATUS_LABELS[workspace.tripStatus]}</p>
                <p>יעד לינה: {workspace.preferences.accommodationArea || "לא הוגדר"}</p>
                <p>תקציב: {formatCurrency(workspace.preferences.budget)}</p>
                <p>תחבורה: {workspace.preferences.transportationPreferences || "לא הוגדר"}</p>
                <p>תחומי עניין: {workspace.preferences.interests || "לא הוגדר"}</p>
                <p>העדפות תזונה: {workspace.preferences.dietaryPreferences || "אין"}</p>
                <p>נגישות: {workspace.preferences.accessibilityNeeds || "אין"}</p>
              </div>
              <div className="rounded-2xl border border-border/70 p-3 text-sm">
                {workspace.lastAiPlanSummary || "אחרי יצירת AI itinerary, נציג כאן תקציר מעשי של ההיגיון מאחורי המסלול."}
              </div>
            </div>
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="itinerary" className={cn("pt-0", activeTab !== "itinerary" && "hidden")}>
        <SectionShell
          title="Itinerary builder"
          description="יום אחר יום, בוקר עד לילה, עם move up/down, duplication, optional, bookings ו-planned מול actual."
          action={
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => actions.addDay(workspace.preferences.startDate)}
            >
              <Plus className="size-4" />
              Day חדש
            </Button>
          }
        >
          <div className="space-y-4">
            {workspace.itineraryDays.map((day) => (
              <div key={day.id} className="section-card space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input
                      value={day.title}
                      onChange={(event) =>
                        actions.updateDay(day.id, { title: event.target.value })
                      }
                    />
                    <Input
                      type="date"
                      value={day.date}
                      onChange={(event) =>
                        actions.updateDay(day.id, { date: event.target.value })
                      }
                    />
                    <Input
                      value={day.transportation}
                      onChange={(event) =>
                        actions.updateDay(day.id, { transportation: event.target.value })
                      }
                      placeholder="תחבורה עיקרית"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedDayId(day.id)}
                    >
                      הצג במפה
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => actions.duplicateDay(day.id)}
                    >
                      שכפול יום
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => actions.removeDay(day.id)}
                    >
                      מחיקה
                    </Button>
                  </div>
                </div>

                <Textarea
                  value={day.notes}
                  onChange={(event) =>
                    actions.updateDay(day.id, { notes: event.target.value })
                  }
                  rows={2}
                  placeholder="תכנון יומי, חלונות זמן, תחבורה, מה חשוב לא לפספס..."
                />

                <div className="space-y-3">
                  {day.items.length > 0 ? (
                    day.items.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-[1.5rem] border border-border/70 bg-background/70 p-4"
                      >
                        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,160px))]">
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Input
                                value={item.name}
                                onChange={(event) =>
                                  actions.updateItem(day.id, item.id, {
                                    name: event.target.value,
                                  })
                                }
                                placeholder="שם פעילות"
                              />
                              {plannedVsActualBadge(item)}
                            </div>
                            <Input
                              value={item.location}
                              onChange={(event) =>
                                actions.updateItem(day.id, item.id, {
                                  location: event.target.value,
                                })
                              }
                              placeholder="מיקום"
                            />
                            <Textarea
                              value={item.plannedNotes}
                              onChange={(event) =>
                                actions.updateItem(day.id, item.id, {
                                  plannedNotes: event.target.value,
                                })
                              }
                              rows={2}
                              placeholder="הערות תכנון"
                            />
                          </div>

                          <Select
                            value={item.slot}
                            onValueChange={(value) =>
                              actions.updateItem(day.id, item.id, {
                                slot: value as DayPart,
                              })
                            }
                          >
                            <SelectTrigger size="sm">
                              <span>{DAY_PART_LABELS[item.slot]}</span>
                            </SelectTrigger>
                            <SelectContent>
                              {SLOT_OPTIONS.map((slot) => (
                                <SelectItem key={slot} value={slot}>
                                  {DAY_PART_LABELS[slot]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Input
                            type="time"
                            value={item.plannedStartTime}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                plannedStartTime: event.target.value,
                              })
                            }
                          />
                          <Input
                            type="number"
                            value={item.estimatedDurationMinutes ?? ""}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                estimatedDurationMinutes: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                            placeholder="דקות"
                          />
                          <Input
                            type="number"
                            value={item.approximatePrice ?? ""}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                approximatePrice: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                            placeholder="מחיר"
                          />
                          <Input
                            value={item.transportation}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                transportation: event.target.value,
                              })
                            }
                            placeholder="תחבורה"
                          />
                        </div>

                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-[repeat(5,minmax(0,1fr))_160px]">
                          <Input
                            value={item.openingHours}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                openingHours: event.target.value,
                              })
                            }
                            placeholder="שעות פתיחה"
                          />
                          <Input
                            value={item.mapLink}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                mapLink: event.target.value,
                              })
                            }
                            placeholder="קישור מפה"
                          />
                          <Input
                            type="number"
                            value={item.travelMinutes ?? ""}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                travelMinutes: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                            placeholder="דקות נסיעה"
                          />
                          <Input
                            value={item.alternativeSuggestion}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                alternativeSuggestion: event.target.value,
                              })
                            }
                            placeholder="אלטרנטיבה"
                          />
                          <Input
                            value={item.bookingWarning}
                            onChange={(event) =>
                              actions.updateItem(day.id, item.id, {
                                bookingWarning: event.target.value,
                              })
                            }
                            placeholder="אזהרת הזמנה"
                          />
                          <Select
                            value={day.id}
                            onValueChange={(value) => {
                              if (value) {
                                actions.moveItemToDay(day.id, value, item.id);
                              }
                            }}
                          >
                            <SelectTrigger size="sm">
                              <span>העבר יום</span>
                            </SelectTrigger>
                            <SelectContent>
                              {workspace.itineraryDays.map((targetDay) => (
                                <SelectItem key={targetDay.id} value={targetDay.id}>
                                  {targetDay.title}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant={item.optional ? "default" : "outline"}
                            size="sm"
                            onClick={() =>
                              actions.updateItem(day.id, item.id, {
                                optional: !item.optional,
                              })
                            }
                          >
                            אופציונלי
                          </Button>
                          <Button
                            variant={item.bookingCompleted ? "default" : "outline"}
                            size="sm"
                            onClick={() =>
                              actions.updateItem(day.id, item.id, {
                                bookingCompleted: !item.bookingCompleted,
                              })
                            }
                          >
                            booking הושלם
                          </Button>
                          <Button
                            variant={item.completed ? "default" : "outline"}
                            size="sm"
                            onClick={() =>
                              actions.updateItem(day.id, item.id, {
                                completed: !item.completed,
                                skipped: item.completed ? item.skipped : false,
                              })
                            }
                          >
                            הושלם בפועל
                          </Button>
                          <Button
                            variant={item.skipped ? "default" : "outline"}
                            size="sm"
                            onClick={() =>
                              actions.updateItem(day.id, item.id, {
                                skipped: !item.skipped,
                                completed: item.skipped ? item.completed : false,
                              })
                            }
                          >
                            דולג
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => actions.moveItem(day.id, item.id, "up")}
                          >
                            למעלה
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => actions.moveItem(day.id, item.id, "down")}
                          >
                            למטה
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => actions.duplicateItem(day.id, item.id)}
                          >
                            שכפול
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => actions.removeItem(day.id, item.id)}
                          >
                            מחיקה
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                      עדיין אין עצירות ליום הזה. אפשר להוסיף ידנית או למשוך המלצות לטאב Recommendation.
                    </div>
                  )}
                </div>

                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => actions.addItem(day.id, "morning")}
                >
                  <Plus className="size-4" />
                  הוספת פעילות
                </Button>
              </div>
            ))}
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="map" className={cn("pt-0", activeTab !== "map" && "hidden")}>
        <SectionShell
          title="Trip map"
          description="מפה משולבת להמלצות, מסלול, מלונות, מסעדות ונקודות תחבורה."
        >
          <TripPlannerMap
            feature={feature}
            days={workspace.itineraryDays}
            recommendations={liveRecommendations}
            selectedDayId={selectedDayId}
            activeFilters={mapFilters}
            onToggleFilter={toggleMapFilter}
            onAddToDay={(recommendation) => actions.addRecommendationToDay(selectedDayId, recommendation)}
            onRemoveFromItinerary={(dayId, itemId) => actions.removeItem(dayId, itemId)}
          />
        </SectionShell>
      </TabsContent>

      <TabsContent
        value="recommendations"
        className={cn("pt-0", activeTab !== "recommendations" && "hidden")}
      >
        <SectionShell
          title="Recommendations"
          description="מקומות אמיתיים שמגיעים ממקורות מפה פתוחים, ובמקומות שחסר בהם מידע אנחנו משלימים עם חיפוש חכם על שמות אמיתיים וממופים."
        >
          <div className="space-y-4">
            <div className="section-card flex flex-col gap-4 p-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CalendarDays className="size-4 text-primary" />
                  <p className="text-sm font-medium">תאריכי הטיול</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  התאריכים עוזרים גם לבניית המסלול וגם להתאמת ההמלצות לעונה, במיוחד כשמקור המפה הפתוח מחזיר מעט מדי תוצאות.
                </p>
              </div>
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="date"
                    value={workspace.preferences.startDate}
                    onChange={(event) =>
                      actions.updatePreferences({ startDate: event.target.value })
                    }
                  />
                  <Input
                    type="date"
                    value={workspace.preferences.endDate}
                    onChange={(event) =>
                      actions.updatePreferences({ endDate: event.target.value })
                    }
                  />
                </div>
                <Button
                  className="gap-1.5 lg:min-w-40"
                  onClick={() => setRecommendationDialogOpen(true)}
                >
                  <Plus className="size-4" />
                  הוספת המלצה
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {ALL_CATEGORIES.map((category) => (
                <Button
                  key={category}
                  size="sm"
                  variant={activeRecommendationCategory === category ? "default" : "outline"}
                  onClick={() => setActiveRecommendationCategory(category)}
                >
                  {RECOMMENDATION_CATEGORY_LABELS[category]}
                  {apiRecommendationsByCategory[category] ? ` · ${apiRecommendationsByCategory[category]!.length}` : ""}
                </Button>
              ))}
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  {RECOMMENDATION_CATEGORY_LABELS[activeRecommendationCategory]}:{" "}
                  {filteredRecommendations.length} תוצאות פעילות
                </span>
                {currentCategoryMeta?.available && currentCategoryMeta.source && (
                  <span className="text-xs">
                    מקור: {currentCategoryMeta.source} · עודכן{" "}
                    {new Date(currentCategoryMeta.retrievedAt).toLocaleDateString("he-IL")}
                  </span>
                )}
              </div>

              {currentCategoryLoading || currentCategoryFetching ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-[28rem] rounded-[2rem]" />
                  ))}
                </div>
              ) : filteredRecommendations.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {filteredRecommendations.map((recommendation) => (
                    <article
                      key={recommendation.id}
                      role="button"
                      tabIndex={0}
                      className="section-card group flex min-h-[31rem] cursor-pointer flex-col overflow-hidden p-5 transition-transform duration-200 hover:-translate-y-1 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      onClick={() => setSelectedRecommendation(recommendation)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedRecommendation(recommendation);
                        }
                      }}
                    >
                      <RecommendationImage
                        recommendation={recommendation}
                        className="h-40 rounded-[1.5rem]"
                      />
                      <div className="mt-4 flex flex-1 flex-col space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge>{RECOMMENDATION_CATEGORY_LABELS[recommendation.category]}</Badge>
                              <Badge variant="outline">
                                {recommendation.reservationRequired ? "דורש הזמנה" : "גמיש"}
                              </Badge>
                              <Badge variant="secondary">
                                {recommendation.recommendedTimeOfDay === "any"
                                  ? "כל היום"
                                  : DAY_PART_LABELS[recommendation.recommendedTimeOfDay]}
                              </Badge>
                            </div>
                            <p className="font-heading text-2xl font-semibold leading-tight">
                              {recommendation.name}
                            </p>
                            <p className="flex items-center gap-1 text-sm text-muted-foreground">
                              <MapPin className="size-4 shrink-0" />
                              {recommendation.location || "מיקום מדויק עדיין לא הוגדר"}
                            </p>
                          </div>
                        </div>

                        <p className="text-sm leading-7 text-muted-foreground">
                          {recommendation.shortDescription ||
                            "אין עדיין תיאור, אבל כבר אפשר לפתוח את הפרטים ולשלב את המקום במסלול."}
                        </p>

                        <div className="grid gap-2 sm:grid-cols-2">
                          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
                            <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                              זמן מומלץ
                            </p>
                            <p className="mt-2 text-sm font-medium">
                              {recommendation.recommendedTimeOfDay === "any"
                                ? "כל היום"
                                : DAY_PART_LABELS[recommendation.recommendedTimeOfDay]}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
                            <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                              {getRecommendationPriceLabel(recommendation.category)}
                            </p>
                            <p className="mt-2 text-sm font-medium">
                              {formatCurrency(recommendation.approximatePrice)}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
                            <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                              שעות פתיחה
                            </p>
                            <p className="mt-2 text-sm font-medium">
                              {recommendation.openingHours || "לא הוגדרו"}
                            </p>
                          </div>
                        </div>

                        <div
                          className="mt-auto flex flex-wrap gap-2"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={() =>
                              actions.addRecommendationToDay(selectedDayId, recommendation)
                            }
                          >
                            <Plus className="size-4" />
                            הוסף למסלול
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => actions.addOrUpdateRecommendation(recommendation)}
                          >
                            שמור ב-workspace
                          </Button>
                          {recommendation.mapLink && (
                            <Button
                              size="sm"
                              variant="outline"
                              nativeButton={false}
                              render={
                                <a
                                  href={recommendation.mapLink}
                                  target="_blank"
                                  rel="noreferrer"
                                />
                              }
                            >
                              פתח מפה
                            </Button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : currentCategoryMeta?.available === false ? (
                <div className="section-card p-4 text-sm text-muted-foreground">
                  כרגע לא הצלחנו להביא תוצאות לקטגוריה &quot;{RECOMMENDATION_CATEGORY_LABELS[activeRecommendationCategory]}&quot;,
                  גם לא ממקור מפה פתוח וגם לא מהשלמת החיפוש החכמה. נסו קטגוריה אחרת או הוסיפו ידנית מהכפתור למעלה.
                </div>
              ) : (
                <div className="section-card p-4 text-sm text-muted-foreground">
                  לא נמצאו תוצאות לקטגוריה הזו כרגע. נסו קטגוריה אחרת, תאריכים אחרים, או הוסיפו המלצה ידנית מהכפתור למעלה.
                </div>
              )}

              <AttractionModal
                recommendation={activeRecommendationDetails}
                open={Boolean(activeRecommendationDetails)}
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedRecommendation(null);
                  }
                }}
                workspace={workspace}
                actions={actions}
                selectedDayId={selectedDayId}
                countryName={country.name}
                isoA2={iso}
              />

              <div className="grid gap-4 lg:grid-cols-3">
                <PlacesSection
                  countryId={country.id}
                  kind="restaurant"
                  title="מסעדות שמורות"
                  emptyHint="עדיין אין מסעדות שמורות במסד הנתונים."
                />
                <PlacesSection
                  countryId={country.id}
                  kind="hotel"
                  title="מלונות שמורים"
                  emptyHint="עדיין אין מלונות שמורים במסד הנתונים."
                />
                <PlacesSection
                  countryId={country.id}
                  kind="attraction"
                  title="אטרקציות שמורות"
                  emptyHint="עדיין אין אטרקציות שמורות במסד הנתונים."
                />
              </div>

              <Dialog
                open={recommendationDialogOpen}
                onOpenChange={(open) => {
                  setRecommendationDialogOpen(open);
                  if (!open) {
                    setRecommendationDraft(createEmptyRecommendationDraft());
                  }
                }}
              >
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>הוספת המלצה ידנית</DialogTitle>
                    <DialogDescription>
                      אפשר להוסיף מקום אישי, מסעדה, אטרקציה או כל עצירה שתרצו לשמור
                      לתוך ה־workspace.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2 md:col-span-2">
                      <Label>שם המקום</Label>
                      <Input
                        value={recommendationDraft.name}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder="שם המקום"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>קטגוריה</Label>
                      <Select
                        value={recommendationDraft.category}
                        onValueChange={(value) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            category: value as RecommendationCategory,
                          }))
                        }
                      >
                        <SelectTrigger size="sm">
                          <span>
                            {RECOMMENDATION_CATEGORY_LABELS[recommendationDraft.category]}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {ALL_CATEGORIES.map((category) => (
                            <SelectItem key={category} value={category}>
                              {RECOMMENDATION_CATEGORY_LABELS[category]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>מיקום</Label>
                      <Input
                        value={recommendationDraft.location}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            location: event.target.value,
                          }))
                        }
                        placeholder="עיר, אזור או כתובת"
                      />
                    </div>

                    <div className="space-y-2 md:col-span-2">
                      <Label>תיאור קצר</Label>
                      <Textarea
                        value={recommendationDraft.shortDescription}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            shortDescription: event.target.value,
                          }))
                        }
                        rows={4}
                        placeholder="למה המקום הזה שווה עצירה?"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>משך משוער</Label>
                      <Input
                        type="number"
                        value={recommendationDraft.estimatedDurationMinutes ?? ""}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            estimatedDurationMinutes: event.target.value
                              ? Number(event.target.value)
                              : null,
                          }))
                        }
                        placeholder="בדקות"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>מחיר משוער</Label>
                      <Input
                        type="number"
                        value={recommendationDraft.approximatePrice ?? ""}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            approximatePrice: event.target.value
                              ? Number(event.target.value)
                              : null,
                          }))
                        }
                        placeholder="מחיר"
                      />
                    </div>

                    <div className="space-y-2 md:col-span-2">
                      <Label>שעות פתיחה</Label>
                      <Input
                        value={recommendationDraft.openingHours}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            openingHours: event.target.value,
                          }))
                        }
                        placeholder="למשל 09:00-18:00"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Lat</Label>
                      <Input
                        type="number"
                        value={recommendationDraft.lat ?? ""}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            lat: event.target.value ? Number(event.target.value) : null,
                          }))
                        }
                        placeholder="Lat"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Lon</Label>
                      <Input
                        type="number"
                        value={recommendationDraft.lon ?? ""}
                        onChange={(event) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            lon: event.target.value ? Number(event.target.value) : null,
                          }))
                        }
                        placeholder="Lon"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>זמן מומלץ</Label>
                      <Select
                        value={recommendationDraft.recommendedTimeOfDay}
                        onValueChange={(value) =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            recommendedTimeOfDay:
                              value as TripRecommendation["recommendedTimeOfDay"],
                          }))
                        }
                      >
                        <SelectTrigger size="sm">
                          <span>
                            {recommendationDraft.recommendedTimeOfDay === "any"
                              ? "כל היום"
                              : DAY_PART_LABELS[
                                  recommendationDraft.recommendedTimeOfDay
                                ]}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">כל היום</SelectItem>
                          {SLOT_OPTIONS.map((slot) => (
                            <SelectItem key={slot} value={slot}>
                              {DAY_PART_LABELS[slot]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>הזמנה מראש</Label>
                      <Button
                        className="w-full"
                        variant={recommendationDraft.reservationRequired ? "default" : "outline"}
                        onClick={() =>
                          setRecommendationDraft((current) => ({
                            ...current,
                            reservationRequired: !current.reservationRequired,
                          }))
                        }
                      >
                        {recommendationDraft.reservationRequired
                          ? "דורש הזמנה"
                          : "ללא הזמנה"}
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setRecommendationDialogOpen(false);
                        setRecommendationDraft(createEmptyRecommendationDraft());
                      }}
                    >
                      ביטול
                    </Button>
                    <Button className="gap-1.5" onClick={submitRecommendationDraft}>
                      <Save className="size-4" />
                      שמירת המלצה
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="budget" className={cn("pt-0", activeTab !== "budget" && "hidden")}>
        <SectionShell
          title="Budget"
          description="Estimated vs actual, קטגוריות הוצאה, הפרשים וממוצע יומי."
        >
          <div className="grid gap-4 lg:grid-cols-4">
            <div className="section-card p-4">
              <p className="text-sm text-muted-foreground">Estimated total</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatCurrency(budgetComparison.plannedCost)}
              </p>
            </div>
            <div className="section-card p-4">
              <p className="text-sm text-muted-foreground">Actual total</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatCurrency(budgetComparison.actualCost)}
              </p>
            </div>
            <div className="section-card p-4">
              <p className="text-sm text-muted-foreground">Difference</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatCurrency(budgetComparison.costDifference)}
              </p>
            </div>
            <div className="section-card p-4">
              <p className="text-sm text-muted-foreground">Daily average</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatCurrency(tripStatistics.averageDailyExpense)}
              </p>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ExpenseTable
              title="Estimated expenses"
              bucket="estimatedExpenses"
              expenses={workspace.estimatedExpenses}
              dayOptions={workspace.itineraryDays}
              onAdd={() => actions.addExpense("estimatedExpenses")}
              onChange={(expenseId, patch) =>
                actions.updateExpense("estimatedExpenses", expenseId, patch)
              }
              onRemove={(expenseId) =>
                actions.removeExpense("estimatedExpenses", expenseId)
              }
            />
            <ExpenseTable
              title="Actual expenses"
              bucket="actualExpenses"
              expenses={workspace.actualExpenses}
              dayOptions={workspace.itineraryDays}
              onAdd={() => actions.addExpense("actualExpenses")}
              onChange={(expenseId, patch) =>
                actions.updateExpense("actualExpenses", expenseId, patch)
              }
              onRemove={(expenseId) => actions.removeExpense("actualExpenses", expenseId)}
            />
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="journal" className={cn("pt-0", activeTab !== "journal" && "hidden")}>
        <SectionShell
          title="Daily journal"
          description="Planned itinerary נשאר נפרד, וכאן מתעדים מה באמת קרה בכל יום."
        >
          <div className="space-y-4">
            {workspace.itineraryDays.map((day) => {
              const journalEntry = journalForDay(workspace, day.id);
              return (
                <div key={day.id} className="section-card space-y-4 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-medium">{day.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {day.date ? formatDate(day.date) : "תאריך לא הוגדר"}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {day.items.filter((item) => item.completed).length}/{day.items.length} בוצעו
                    </Badge>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <div className="space-y-3">
                      <Textarea
                        value={journalEntry?.dailySummary ?? ""}
                        onChange={(event) =>
                          actions.upsertJournalEntry(day.id, {
                            dayId: day.id,
                            date: day.date,
                            dailySummary: event.target.value,
                          })
                        }
                        rows={3}
                        placeholder="Daily summary"
                      />
                      <Textarea
                        value={journalEntry?.notes ?? ""}
                        onChange={(event) =>
                          actions.upsertJournalEntry(day.id, {
                            dayId: day.id,
                            date: day.date,
                            notes: event.target.value,
                          })
                        }
                        rows={3}
                        placeholder="Notes, surprises, fixes on the fly..."
                      />
                      <Textarea
                        value={journalEntry?.placesActuallyVisited ?? ""}
                        onChange={(event) =>
                          actions.upsertJournalEntry(day.id, {
                            dayId: day.id,
                            date: day.date,
                            placesActuallyVisited: event.target.value,
                          })
                        }
                        rows={2}
                        placeholder="Places actually visited"
                      />
                    </div>

                    <div className="space-y-3">
                      <Textarea
                        value={journalEntry?.activitiesSkipped ?? ""}
                        onChange={(event) =>
                          actions.upsertJournalEntry(day.id, {
                            dayId: day.id,
                            date: day.date,
                            activitiesSkipped: event.target.value,
                          })
                        }
                        rows={2}
                        placeholder="Activities skipped"
                      />
                      <Input
                        value={journalEntry?.favoriteMoment ?? ""}
                        onChange={(event) =>
                          actions.upsertJournalEntry(day.id, {
                            dayId: day.id,
                            date: day.date,
                            favoriteMoment: event.target.value,
                          })
                        }
                        placeholder="Favorite moment"
                      />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          type="number"
                          value={journalEntry?.moodRating ?? ""}
                          onChange={(event) =>
                            actions.upsertJournalEntry(day.id, {
                              dayId: day.id,
                              date: day.date,
                              moodRating: event.target.value
                                ? Number(event.target.value)
                                : null,
                            })
                          }
                          placeholder="Mood / rating"
                        />
                        <Input
                          value={journalEntry?.weatherNotes ?? ""}
                          onChange={(event) =>
                            actions.upsertJournalEntry(day.id, {
                              dayId: day.id,
                              date: day.date,
                              weatherNotes: event.target.value,
                            })
                          }
                          placeholder="Weather notes"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/70 p-3 text-sm">
                    <p className="font-medium">Planned vs actual</p>
                    <p className="mt-2 text-muted-foreground">
                      מתוכננות {day.items.length} פעילויות, הושלמו {day.items.filter((item) => item.completed).length},
                      דולגו {day.items.filter((item) => item.skipped).length}.
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="photos" className={cn("pt-0", activeTab !== "photos" && "hidden")}>
        <SectionShell
          title="Photos and memories"
          description="גלריית הזיכרונות המקומית יושבת מעל גלריית התמונות האמיתית שכבר קיימת בפרויקט."
          action={
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => actions.upsertMemory(actions.createMemory())}
            >
              <ImagePlus className="size-4" />
              זיכרון חדש
            </Button>
          }
        >
          <div className="space-y-4">
            {workspace.memories.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {workspace.memories.map((memory) => (
                  <div key={memory.id} className="section-card group space-y-3 p-4">
                    {memory.imageUrl ? (
                      <div className="h-40 w-full overflow-hidden rounded-xl shadow-sm">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={memory.imageUrl}
                          alt=""
                          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                        />
                      </div>
                    ) : (
                      <div className="flex h-40 w-full items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">
                        הדביקו URL של תמונה
                      </div>
                    )}
                    <Input
                      value={memory.imageUrl}
                      onChange={(event) =>
                        actions.upsertMemory({
                          ...memory,
                          imageUrl: event.target.value,
                        })
                      }
                      placeholder="Image URL"
                    />
                    <Input
                      value={memory.caption}
                      onChange={(event) =>
                        actions.upsertMemory({
                          ...memory,
                          caption: event.target.value,
                        })
                      }
                      placeholder="Caption"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="date"
                        value={memory.date}
                        onChange={(event) =>
                          actions.upsertMemory({
                            ...memory,
                            date: event.target.value,
                          })
                        }
                      />
                      <Input
                        value={memory.location}
                        onChange={(event) =>
                          actions.upsertMemory({
                            ...memory,
                            location: event.target.value,
                          })
                        }
                        placeholder="Location"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={memory.favorite ? "default" : "outline"}
                        onClick={() =>
                          actions.upsertMemory({
                            ...memory,
                            favorite: !memory.favorite,
                          })
                        }
                      >
                        <Star className="size-4" />
                        Favorite
                      </Button>
                      <Button
                        size="sm"
                        variant={memory.cover ? "default" : "outline"}
                        onClick={() =>
                          actions.upsertMemory({
                            ...memory,
                            cover: !memory.cover,
                          })
                        }
                      >
                        Cover
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => actions.removeMemory(memory.id)}
                      >
                        מחיקה
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="section-card p-4 text-sm text-muted-foreground">
                עדיין לא נוצרו cards של זיכרונות. אפשר להוסיף caption, תאריך, location, favorite photo ו-cover photo.
              </div>
            )}

            <PhotoGallery countryId={country.id} title="גלריית תמונות" />
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="summary" className={cn("pt-0", activeTab !== "summary" && "hidden")}>
        <SectionShell
          title="Trip summary and journal wrap-up"
          description="סיכום סופי, planned vs actual, lessons learned ושימור שדות הסיכום הקיימים."
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_360px]">
            <div className="space-y-4">
              <div className="section-card grid gap-3 p-4 md:grid-cols-2">
                <Input
                  value={workspace.summary.favoritePlace}
                  onChange={(event) =>
                    actions.updateSummary({ favoritePlace: event.target.value })
                  }
                  placeholder="Favorite place"
                />
                <Input
                  value={workspace.summary.favoriteRestaurant}
                  onChange={(event) =>
                    actions.updateSummary({
                      favoriteRestaurant: event.target.value,
                    })
                  }
                  placeholder="Favorite restaurant"
                />
                <Input
                  value={workspace.summary.bestDay}
                  onChange={(event) => actions.updateSummary({ bestDay: event.target.value })}
                  placeholder="Best day"
                />
                <Input
                  value={workspace.summary.biggestSurprise}
                  onChange={(event) =>
                    actions.updateSummary({
                      biggestSurprise: event.target.value,
                    })
                  }
                  placeholder="Biggest surprise"
                />
                <Input
                  value={workspace.summary.favoriteMemory}
                  onChange={(event) =>
                    actions.updateSummary({
                      favoriteMemory: event.target.value,
                    })
                  }
                  placeholder="Favorite memory"
                />
                <Input
                  type="number"
                  value={workspace.summary.personalRating ?? ""}
                  onChange={(event) =>
                    actions.updateSummary({
                      personalRating: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                  placeholder="Personal rating"
                />
                <Textarea
                  value={workspace.summary.overallTripSummary}
                  onChange={(event) =>
                    actions.updateSummary({
                      overallTripSummary: event.target.value,
                    })
                  }
                  rows={3}
                  placeholder="Overall trip summary"
                />
                <Textarea
                  value={workspace.summary.tripHighlights}
                  onChange={(event) =>
                    actions.updateSummary({
                      tripHighlights: event.target.value,
                    })
                  }
                  rows={3}
                  placeholder="Trip highlights"
                />
                <Textarea
                  value={workspace.summary.lessonsLearned}
                  onChange={(event) =>
                    actions.updateSummary({
                      lessonsLearned: event.target.value,
                    })
                  }
                  rows={3}
                  placeholder="Lessons learned"
                />
                <Textarea
                  value={workspace.summary.differentlyNextTime}
                  onChange={(event) =>
                    actions.updateSummary({
                      differentlyNextTime: event.target.value,
                    })
                  }
                  rows={3}
                  placeholder="What to do differently next time"
                />
                <Textarea
                  value={workspace.summary.recommendationsForOthers}
                  onChange={(event) =>
                    actions.updateSummary({
                      recommendationsForOthers: event.target.value,
                    })
                  }
                  rows={3}
                  placeholder="Recommendations for others"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">Planned cost</p>
                  <p className="mt-2 text-xl font-semibold">
                    {formatCurrency(budgetComparison.plannedCost)}
                  </p>
                </div>
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">Actual cost</p>
                  <p className="mt-2 text-xl font-semibold">
                    {formatCurrency(budgetComparison.actualCost)}
                  </p>
                </div>
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">Completed activities</p>
                  <p className="mt-2 text-xl font-semibold">
                    {budgetComparison.completedActivities}/{budgetComparison.plannedActivities}
                  </p>
                </div>
                <div className="section-card p-4">
                  <p className="text-sm text-muted-foreground">Spontaneous additions</p>
                  <p className="mt-2 text-xl font-semibold">
                    {budgetComparison.spontaneousAdditions}
                  </p>
                </div>
              </div>

              <CountryOverviewSection country={country} showStatus={false} />
              <CountryNotesSection country={country} />
              <CountryRatingsSection countryId={country.id} />
            </div>

            <div className="space-y-4">
              <div className="section-card space-y-3 p-4">
                <div className="flex items-center gap-2">
                  <NotebookPen className="size-4 text-primary" />
                  <h3 className="font-medium">Trip statistics</h3>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">ימי טיול</p>
                    <p className="mt-1 text-lg font-semibold">{tripStatistics.totalTripDays}</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">מקומות שבוצעו</p>
                    <p className="mt-1 text-lg font-semibold">{tripStatistics.placesVisited}</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">מרחק בין עצירות</p>
                    <p className="mt-1 text-lg font-semibold">{tripStatistics.distanceStops} ק&quot;מ</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">קטגוריה מובילה</p>
                    <p className="mt-1 text-lg font-semibold">{tripStatistics.topCategoryVisited}</p>
                  </div>
                </div>
              </div>
              <CountryStatsSection countryId={country.id} />
            </div>
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="practical" className={cn("pt-0", activeTab !== "practical" && "hidden")}>
        <SectionShell
          title="Practical information"
          description="מזג אוויר, ערים, המלצות AI ומידע שטוב לשמור נגיש לפני ובמהלך הטיול."
        >
          <div className="space-y-6">
            <CountryWeatherSection lat={centerLat} lon={centerLon} />
            <CountrySafetyInfo isoA2={iso} />
            <div className="section-card p-4">
              <CountryAiRecommendations isoA2={iso} countryName={country.name} />
            </div>
            <CountryCitiesSection countryId={country.id} countryName={country.name} iso={iso} />
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="currency" className={cn("pt-0", activeTab !== "currency" && "hidden")}>
        <SectionShell
          title="המרת מטבע"
          description="שערי חליפין עדכניים מול המטבע המקומי, מתעדכנים אוטומטית כל יום."
        >
          <CountryCurrencyConverter isoA2={iso} countryName={country.name} />
        </SectionShell>
      </TabsContent>
    </>
  );
}
