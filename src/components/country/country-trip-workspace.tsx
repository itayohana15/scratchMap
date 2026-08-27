"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  CalendarDays,
  Filter,
  MapPin,
  Plus,
  Route,
  Save,
  Trash2,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AttractionModal } from "@/components/country/attraction-modal";
import { RecommendationFeedbackButtons } from "@/components/country/recommendation-feedback-buttons";
import { CountryAboutSection } from "@/components/country/country-about-section";
import { CountryItineraryHistorySection } from "@/components/country/country-itinerary-history-section";
import { CountryCitiesSection } from "@/components/country/country-cities-section";
import { CountryCurrencyConverter } from "@/components/country/country-currency-converter";
import { CountrySafetyInfo } from "@/components/country/country-safety-info";
import { CountryTripSummarySection } from "@/components/country/country-trip-summary-section";
import { CountryWeatherSection } from "@/components/country/country-weather-section";
import { TripCreationWizard } from "@/components/country/trip-wizard/trip-creation-wizard";
import { useCountryMiniMap } from "@/components/country/use-country-mini-map";
import type { useCountryTripWorkspace } from "@/components/country/use-country-trip-workspace";
import { CountryAiRecommendations } from "@/components/shared/country-ai-recommendations";
import { PlacesSection } from "@/components/shared/places-section";
import { STATUS_COLORS } from "@/components/map/status-colors";
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
import { useCountryItineraries } from "@/lib/queries/country-itineraries";
import { usePlacesForCountry } from "@/lib/queries/places";
import { usePreferenceProfile } from "@/lib/queries/preference-profile";
import { useAllRecommendationFeedback } from "@/lib/queries/recommendation-feedback";
import {
  aggregateFeedbackByPlace,
  computeAlreadyVisited,
  computeRecommendationScore,
} from "@/lib/preference-learning";
import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import type { CountryFeatureProperties } from "@/lib/map/geo";
import type { Tables } from "@/lib/supabase/types";
import {
  DAY_PART_LABELS,
  EXPENSE_CATEGORY_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  buildMapLink,
  buildTripComparison,
  buildTripStatistics,
  createId,
  type CountryTripWorkspaceState,
  type DayPart,
  type RecommendationCategory,
  type TripExpense,
  type TripItineraryDay,
  type TripItineraryItem,
  type TripRecommendation,
  type TripWorkspaceTab,
} from "@/lib/trip-workspace";
import { formatCurrency, formatDate } from "@/lib/format";
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
// "practical" (סידורים) is deliberately never served by
// /api/countries/[iso]/recommendations — it's user- or template-generated,
// never AI-sourced (see that route's CATEGORY_VALUES). Any code path that
// actually calls the recommendations API must exclude it, or every request
// for it 400s. UI-only lists (map-marker filter chips, the manual
// "add recommendation" category picker) keep using ALL_CATEGORIES since
// they never trigger a fetch for the selected category.
const AI_SOURCED_CATEGORIES = ALL_CATEGORIES.filter((category) => category !== "practical");
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

function plannedVsActualBadge(item: TripItineraryItem) {
  if (item.completed) return <Badge variant="secondary">בוצע</Badge>;
  if (item.skipped) return <Badge variant="outline">דולג</Badge>;
  if (item.optional) return <Badge variant="outline">אופציונלי</Badge>;
  return <Badge variant="outline">מתוכנן</Badge>;
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
          <p class="text-xs text-muted-foreground">${RECOMMENDATION_CATEGORY_LABELS[recommendation.category]}</p>
          <p class="text-xs text-muted-foreground">${recommendation.location || ""}</p>
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
          <p class="text-xs text-muted-foreground">${DAY_PART_LABELS[item.slot]}${item.plannedStartTime ? ` · ${item.plannedStartTime}` : ""}</p>
          <p class="text-xs text-muted-foreground">${item.location || ""}</p>
        `;
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className =
          "w-full rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground";
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
          <h2 className="font-heading text-[1.6rem] font-bold tracking-tight text-foreground sm:text-[1.9rem]">
            {title}
          </h2>
          {description && (
            <p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base">
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
  const router = useRouter();
  const { workspace, actions, hydrated } = workspaceController;
  const accentColor = STATUS_COLORS[country.status].light;
  const { data: attractionPlaces } = usePlacesForCountry(country.id, "attraction");
  const { data: restaurantPlaces } = usePlacesForCountry(country.id, "restaurant");
  const { data: hotelPlaces } = usePlacesForCountry(country.id, "hotel");
  const [selectedDayId, setSelectedDayId] = useState(workspace.itineraryDays[0]?.id ?? "");
  const [wizardOpen, setWizardOpen] = useState(false);
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

    const categoriesToWarm = AI_SOURCED_CATEGORIES.filter(
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

  const [newToMeOnly, setNewToMeOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { data: preferenceProfile } = usePreferenceProfile();
  const { data: recommendationFeedback = [] } = useAllRecommendationFeedback();
  const { data: countryItineraries = [] } = useCountryItineraries(iso);

  const alreadyVisited = useMemo(() => computeAlreadyVisited(countryItineraries), [countryItineraries]);
  const feedbackByPlaceKey = useMemo(() => aggregateFeedbackByPlace(recommendationFeedback), [recommendationFeedback]);

  const scoredRecommendations = useMemo(() => {
    const scoreContext = {
      explicitPreferences: preferenceProfile?.explicit_preferences ?? {},
      inferredPreferences: {},
      feedbackByPlaceKey,
      alreadyVisited,
    };
    return liveRecommendations
      .filter((recommendation) => recommendation.category === activeRecommendationCategory)
      .map((recommendation) => ({ recommendation, score: computeRecommendationScore(recommendation, scoreContext) }))
      .filter(({ recommendation }) => {
        const visited = alreadyVisited.get(
          recommendation.lat != null && recommendation.lon != null
            ? `coords:${recommendation.lat.toFixed(4)}:${recommendation.lon.toFixed(4)}`
            : `name:${recommendation.name.trim().toLowerCase()}::${recommendation.location.trim().toLowerCase()}`
        );
        if (newToMeOnly && visited) return false;
        if (favoritesOnly && !visited?.favorite) return false;
        return true;
      })
      .sort((a, b) => b.score.total - a.score.total);
  }, [activeRecommendationCategory, alreadyVisited, favoritesOnly, feedbackByPlaceKey, liveRecommendations, newToMeOnly, preferenceProfile]);

  const filteredRecommendations = scoredRecommendations.map(({ recommendation }) => recommendation);
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
    <div
      className={cn(
        "space-y-8",
        "[&_.section-card]:!rounded-[24px] [&_.section-card]:!border-border [&_.section-card]:!bg-card [&_.section-card]:!shadow-sm [&_.section-card]:transition-shadow [&_.section-card]:hover:!shadow-md",
        "[&_[data-slot=input]]:!h-11 [&_[data-slot=input]]:!rounded-[16px] [&_[data-slot=input]]:!border-input [&_[data-slot=input]]:!bg-background [&_[data-slot=input]]:!px-3.5 [&_[data-slot=input]]:!text-foreground [&_[data-slot=input]]:placeholder:!text-muted-foreground",
        "[&_[data-slot=textarea]]:!min-h-[110px] [&_[data-slot=textarea]]:!rounded-[18px] [&_[data-slot=textarea]]:!border-input [&_[data-slot=textarea]]:!bg-background [&_[data-slot=textarea]]:!px-3.5 [&_[data-slot=textarea]]:!py-3 [&_[data-slot=textarea]]:!text-foreground [&_[data-slot=textarea]]:placeholder:!text-muted-foreground",
        "[&_[data-slot=select-trigger]]:!h-11 [&_[data-slot=select-trigger]]:!w-full [&_[data-slot=select-trigger]]:!rounded-[16px] [&_[data-slot=select-trigger]]:!border-input [&_[data-slot=select-trigger]]:!bg-background [&_[data-slot=select-trigger]]:!px-3.5 [&_[data-slot=select-trigger]]:!text-foreground",
        "[&_[data-slot=select-content]]:!rounded-[18px] [&_[data-slot=select-content]]:!border [&_[data-slot=select-content]]:!border-border [&_[data-slot=select-content]]:!bg-popover [&_[data-slot=select-content]]:!text-popover-foreground"
      )}
    >
      <TabsContent value="overview" className={cn("pt-0", activeTab !== "overview" && "hidden")}>
        <SectionShell
          title="סקירת המדינה"
          description="מדריך עומק למדינה: היסטוריה, תרבות, טבע, מסלולים, עונות, תקציב ומידע פרקטי."
        >
          <div
            className="section-card p-6"
            style={{
              backgroundColor: hexToRgba(accentColor, 0.05),
              borderColor: hexToRgba(accentColor, 0.18),
            }}
          >
            <CountryAboutSection isoA2={iso} countryName={country.name} />
          </div>
        </SectionShell>
      </TabsContent>

      <TabsContent value="itinerary" className={cn("pt-0", activeTab !== "itinerary" && "hidden")}>
        <CountryItineraryHistorySection
          iso={iso}
          country={country}
          onOpenWizard={() => setWizardOpen(true)}
        />
        <TripCreationWizard
          iso={iso}
          country={country}
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          onGenerated={(itineraryId) => router.push(`/trips/${itineraryId}`)}
        />
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
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">תאריך התחלה</p>
                    <Input
                      type="date"
                      value={workspace.preferences.startDate}
                      onChange={(event) =>
                        actions.updatePreferences({ startDate: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">תאריך סיום</p>
                    <Input
                      type="date"
                      value={workspace.preferences.endDate}
                      onChange={(event) =>
                        actions.updatePreferences({ endDate: event.target.value })
                      }
                    />
                  </div>
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
              {AI_SOURCED_CATEGORIES.map((category) => (
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
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={newToMeOnly ? "secondary" : "outline"} onClick={() => setNewToMeOnly((current) => !current)}>
                  עוד לא הייתי
                </Button>
                <Button size="sm" variant={favoritesOnly ? "secondary" : "outline"} onClick={() => setFavoritesOnly((current) => !current)}>
                  מקומות שאהבתי
                </Button>
              </div>
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
                          <RecommendationFeedbackButtons
                            place={recommendation}
                            category={recommendation.category}
                            tripId={null}
                          />
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

      <TabsContent
        value="country_summary"
        className={cn("pt-0", activeTab !== "country_summary" && "hidden")}
      >
        <SectionShell
          title="סיכום המדינה"
          description="צבירה של כל הטיולים שהושלמו במדינה הזו — דירוגים, סטטיסטיקות, מפה ומועדפים."
        >
          <CountryTripSummarySection iso={iso} country={country} />
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
    </div>
  );
}
