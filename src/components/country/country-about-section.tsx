"use client";

import {
  CalendarDays,
  ChevronDown,
  Clock3,
  ExternalLink,
  Globe2,
  Landmark,
  Map,
  MapPinned,
  Plane,
  Route,
  ScrollText,
  Shield,
  Sparkles,
  UtensilsCrossed,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  CountryAttraction,
  CountryBudgetTier,
  CountryDestination,
  CountryFoodSpot,
  CountryNamedNote,
  CountryTimelineEntry,
} from "@/lib/ai/country-knowledge";
import { useCountryAiRecommendation } from "@/lib/ai/country-recommendations";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

interface CountryAboutSectionProps {
  isoA2: string;
  countryName: string;
}

function buildMapLink(name: string, lat: number | null, lon: number | null) {
  if (lat != null && lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }
  return name ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}` : "";
}

function textList(items: string[]) {
  return items.filter(Boolean);
}

function valueLine(label: string, value: string | null | undefined) {
  if (!value) return null;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/70 p-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm leading-6 text-foreground">{value}</p>
    </div>
  );
}

function LinkChip({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
    >
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function PillList({ items }: { items: string[] }) {
  const list = textList(items);
  if (list.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {list.map((item, index) => (
        // Plain AI-generated display strings, no other stable id available —
        // a repeated value (e.g. a route that legitimately revisits the same
        // city) is valid data, never deduped, so the key must stay unique
        // per occurrence rather than per value.
        <Badge key={`${item}-${index}`} variant="secondary" className="rounded-full px-3 py-1 text-xs font-normal">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function BulletList({ items, className }: { items: string[]; className?: string }) {
  const list = textList(items);
  if (list.length === 0) return null;

  return (
    <ul className={cn("space-y-2 text-sm leading-6 text-muted-foreground", className)}>
      {list.map((item, index) => (
        // Same reasoning as PillList above — e.g. idea.route can legitimately
        // list the same city twice (a real round-trip: "לאס וגאס" ->
        // "הגרנד קניון" -> "הפארק הלאומי ציון" -> "לאס וגאס"), so the key
        // must be unique per occurrence, not per display value.
        <li key={`${item}-${index}`} className="flex gap-2">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/75" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function LabeledList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  const list = textList(items);
  if (list.length === 0) return null;

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      <BulletList items={list} />
    </div>
  );
}

function TimelineList({ items }: { items: CountryTimelineEntry[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        // year+event is usually distinct enough on its own, but an
        // AI-generated timeline repeating the same entry is still real
        // data (never deduped here) — index keeps the key unique regardless.
        <div key={`${item.year}-${item.event}-${index}`} className="grid gap-2 rounded-2xl border border-border/70 p-3 md:grid-cols-[110px_minmax(0,1fr)]">
          <p className="text-sm font-semibold text-foreground">{item.year}</p>
          <p className="text-sm leading-6 text-muted-foreground">{item.event}</p>
        </div>
      ))}
    </div>
  );
}

function NamedNotes({ items }: { items: CountryNamedNote[] }) {
  if (items.length === 0) return null;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((item, index) => (
        <div key={`${item.name}-${index}`} className="rounded-2xl border border-border/70 p-4">
          <p className="text-sm font-semibold text-foreground">{item.name}</p>
          {item.note && <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.note}</p>}
        </div>
      ))}
    </div>
  );
}

function BudgetTierCard({
  title,
  tier,
}: {
  title: string;
  tier: CountryBudgetTier;
}) {
  const hasContent = [tier.hotel, tier.food, tier.attractions, tier.transportation, tier.totalPerDay].some(Boolean);
  if (!hasContent) return null;

  return (
    <div className="rounded-[24px] border border-border/70 bg-background/80 p-5">
      <h4 className="text-base font-semibold text-foreground">{title}</h4>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {valueLine("מלון", tier.hotel)}
        {valueLine("אוכל", tier.food)}
        {valueLine("אטרקציות", tier.attractions)}
        {valueLine("תחבורה", tier.transportation)}
      </div>
      {tier.totalPerDay && (
        <div className="mt-4 rounded-2xl bg-primary/8 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">סה&quot;כ ליום</p>
          <p className="mt-1 text-base font-semibold text-foreground">{tier.totalPerDay}</p>
        </div>
      )}
    </div>
  );
}

function PlacePhoto({
  query,
  alt,
}: {
  query: string;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setSrc(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSrc(null);

    fetch(`/api/places/photo?q=${encodeURIComponent(trimmedQuery)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { photoUrl?: string | null } | null) => {
        if (!cancelled) {
          setSrc(data?.photoUrl ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [query]);

  if (src) {
    return (
      <div className="overflow-hidden rounded-[20px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="h-48 w-full object-cover transition-transform duration-500 group-hover:scale-105" />
      </div>
    );
  }

  return (
    <div className="flex h-48 items-center justify-center rounded-[20px] bg-gradient-to-br from-primary/15 via-primary/8 to-transparent px-4 text-center text-sm text-muted-foreground">
      {loading ? "טוענים תמונה..." : "לא נמצאה תמונה מתאימה כרגע"}
    </div>
  );
}

function DestinationCard({ destination }: { destination: CountryDestination }) {
  const mapHref = buildMapLink(
    destination.location.label || destination.name,
    destination.location.lat,
    destination.location.lon
  );

  return (
    <article className="group overflow-hidden rounded-[28px] border border-border/70 bg-background/80 p-4 shadow-sm transition-transform duration-300 hover:-translate-y-1">
      <PlacePhoto query={destination.photoQuery || destination.name} alt={destination.name} />
      <div className="mt-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-lg font-semibold text-foreground">{destination.name}</h4>
            {destination.location.label && (
              <p className="mt-1 text-sm text-muted-foreground">{destination.location.label}</p>
            )}
          </div>
          {destination.bestSeason && <Badge variant="outline">{destination.bestSeason}</Badge>}
        </div>

        {destination.shortDescription && (
          <p className="text-sm leading-6 text-muted-foreground">{destination.shortDescription}</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {valueLine("למה להגיע", destination.whyVisit)}
          {valueLine("משך ביקור", destination.estimatedVisitDuration)}
          {valueLine("עונה מומלצת", destination.bestSeason)}
          {valueLine("עלות כניסה", destination.entryPrice)}
        </div>

        {mapHref && <LinkChip href={mapHref}>מיקום במפה</LinkChip>}
      </div>
    </article>
  );
}

function AttractionCard({ attraction }: { attraction: CountryAttraction }) {
  const mapHref = buildMapLink(
    attraction.coordinates.label || attraction.name,
    attraction.coordinates.lat,
    attraction.coordinates.lon
  );

  return (
    <div className="rounded-[24px] border border-border/70 bg-background/75 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h5 className="text-sm font-semibold text-foreground">{attraction.name}</h5>
          {attraction.shortDescription && (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{attraction.shortDescription}</p>
          )}
        </div>
        {attraction.rating != null && (
          <Badge variant="secondary" className="shrink-0 rounded-full px-2.5">
            {attraction.rating.toFixed(1)}/10
          </Badge>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {valueLine("פופולריות", attraction.popularity)}
        {valueLine("משך משוער", attraction.estimatedDuration)}
        {valueLine("שעות פתיחה", attraction.openingHours)}
        {valueLine("מחיר ממוצע", attraction.averageTicketPrice)}
        {valueLine("מתאים למשפחות", attraction.familyFriendly)}
        {valueLine("נגישות", attraction.wheelchairAccessibility)}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {mapHref && <LinkChip href={mapHref}>נקודה במפה</LinkChip>}
        {attraction.officialWebsite && <LinkChip href={attraction.officialWebsite}>אתר רשמי</LinkChip>}
      </div>
    </div>
  );
}

function FoodSpotCard({ spot }: { spot: CountryFoodSpot }) {
  const mapHref = buildMapLink(`${spot.name} ${spot.cityOrArea}`.trim(), null, null);

  return (
    <article className="rounded-[24px] border border-border/70 bg-background/75 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-foreground">{spot.name}</h4>
          {spot.cityOrArea && <p className="mt-1 text-sm text-muted-foreground">{spot.cityOrArea}</p>}
        </div>
        {spot.type && (
          <Badge variant="secondary" className="shrink-0 rounded-full px-3 py-1">
            {spot.type}
          </Badge>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {valueLine("מה לנסות", spot.whatToTry)}
        {valueLine("למה להגיע", spot.whyGo)}
        {valueLine("טווח מחירים", spot.priceLevel)}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {mapHref && <LinkChip href={mapHref}>חיפוש במפה</LinkChip>}
      </div>
    </article>
  );
}

function HubSection({
  title,
  description,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-[28px] border border-border/70 bg-card/80">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 marker:hidden">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        <ChevronDown className="size-5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>

      <div className="border-t border-border/70 px-5 py-5">{children}</div>
    </details>
  );
}

function AboutSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-44 rounded-[28px]" />
      <Skeleton className="h-28 rounded-[28px]" />
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-20 rounded-[28px]" />
      ))}
    </div>
  );
}

export function CountryAboutSection({ isoA2, countryName }: CountryAboutSectionProps) {
  const { data, isLoading, isError, error } = useCountryAiRecommendation(isoA2, countryName);

  if (isLoading) {
    return <AboutSkeleton />;
  }

  if (isError) {
    return (
      <div className="glass-card flex items-start gap-2 px-4 py-3 text-sm text-muted-foreground">
        <Shield className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>
          לא הצלחנו לטעון מידע על {countryName} כרגע.{" "}
          {error instanceof Error ? error.message : "נסו שוב מאוחר יותר."}
        </span>
      </div>
    );
  }

  if (!data) return null;

  const overviewReasons = textList(data.overview.bestReasonsToVisit);
  const overviewImpressions = textList(data.overview.firstImpressions);
  const monthCards = data.bestTime.months;
  const safetyScore = data.safety.overallSafetyScore != null ? `${data.safety.overallSafetyScore.toFixed(1)}/10` : "";

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[32px] border border-border/70 bg-gradient-to-br from-primary/10 via-card to-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="size-4" />
              <span className="text-xs font-semibold uppercase tracking-[0.22em]">מרכז ידע וטיול</span>
            </div>
            <h3 className="mt-3 font-heading text-[1.8rem] font-bold tracking-tight text-foreground">
              {countryName} על קצה המזלג
            </h3>
            <p className="mt-3 text-base leading-8 text-muted-foreground">
              {data.overview.shortSummary || data.summary}
            </p>
          </div>

          <div className="grid min-w-[240px] gap-3 sm:grid-cols-2">
            {valueLine("מפורסמת בזכות", data.overview.whyFamous)}
            {valueLine("מה מייחד אותה", data.overview.whatMakesItUnique)}
            {valueLine("העונה הכי טובה", data.bestTime.bestSeason)}
            {valueLine("בטיחות כללית", safetyScore)}
          </div>
        </div>

        {(overviewReasons.length > 0 || overviewImpressions.length > 0) && (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-[24px] border border-border/70 bg-background/70 p-4">
              <h4 className="text-sm font-semibold text-foreground">למה כדאי לבקר</h4>
              <div className="mt-3">
                <BulletList items={overviewReasons} />
              </div>
            </div>
            <div className="rounded-[24px] border border-border/70 bg-background/70 p-4">
              <h4 className="text-sm font-semibold text-foreground">רושם ראשוני מהמדינה</h4>
              <div className="mt-3">
                <BulletList items={overviewImpressions} />
              </div>
            </div>
          </div>
        )}
      </section>

      <HubSection
        title="סקירה כללית"
        description="סיכום מהיר לצד מבט עמוק יותר על האופי, המשיכה והייחוד של המדינה."
        icon={Globe2}
        defaultOpen
      >
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            {valueLine("מפורסמת בזכות", data.overview.whyFamous)}
            {valueLine("מה הופך אותה לייחודית", data.overview.whatMakesItUnique)}
          </div>

          {data.overview.longOverview.length > 0 && (
            <div className="space-y-4">
              {data.overview.longOverview.map((paragraph, index) => (
                <p key={index} className="text-sm leading-7 text-muted-foreground">
                  {paragraph}
                </p>
              ))}
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="סיבות מובילות לבקר" items={data.overview.bestReasonsToVisit} />
            <LabeledList title="רשמים ראשונים מעניינים" items={data.overview.firstImpressions} />
          </div>
        </div>
      </HubSection>

      <HubSection
        title="היסטוריה"
        description="מהשורשים הקדומים ועד האירועים והדמויות שעיצבו את המדינה המודרנית."
        icon={ScrollText}
      >
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-3">
            {valueLine("היסטוריה קדומה", data.history.ancientHistory)}
            {valueLine("עצמאות", data.history.independence)}
            {valueLine("היסטוריה מודרנית", data.history.modernHistory)}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="אירועים היסטוריים מרכזיים" items={data.history.majorHistoricalEvents} />
            <LabeledList title="ממלכות ואימפריות" items={data.history.kingdomsAndEmpires} />
          </div>

          <div>
            <h4 className="mb-3 text-sm font-semibold text-foreground">ציר זמן חשוב</h4>
            <TimelineList items={data.history.timeline} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="מלחמות וסכסוכים מעצבים" items={data.history.shapingWars} />
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">דמויות היסטוריות</h4>
              <NamedNotes items={data.history.historicalFigures} />
            </div>
          </div>
        </div>
      </HubSection>

      <HubSection
        title="גיאוגרפיה וטבע"
        description="שטח, גבולות, אזורי אקלים ונופי המפתח שכדאי להכיר."
        icon={Map}
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {valueLine("שטח כולל", data.geography.totalArea)}
            {valueLine("ההר הגבוה ביותר", data.geography.highestMountain)}
            {valueLine("הנהר הארוך ביותר", data.geography.longestRiver)}
            {valueLine("רעידות אדמה/געש", data.geography.earthquakesAndVolcanoes)}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="גבולות" items={data.geography.borders} />
            <LabeledList title="אגמים גדולים" items={data.geography.largestLakes} />
            <LabeledList title="איים" items={data.geography.islands} />
            <LabeledList title="מדבריות" items={data.geography.deserts} />
            <LabeledList title="יערות" items={data.geography.forests} />
            <LabeledList title="פארקים לאומיים" items={data.geography.nationalParks} />
          </div>

          <div>
            <h4 className="mb-3 text-sm font-semibold text-foreground">אזורי אקלים</h4>
            <PillList items={data.geography.climateZones} />
          </div>
        </div>
      </HubSection>

      <HubSection
        title="אנשים ותרבות"
        description="שפות, מסורות, ערכים, חגים ואיך נראים היומיום והאירוח המקומי."
        icon={Users}
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {valueLine("אוכלוסייה", data.peopleCulture.population)}
            {valueLine("אירוח", data.peopleCulture.hospitality)}
            {valueLine("חיי יום יום", data.peopleCulture.dailyLife)}
            {valueLine("תרבות משפחתית", data.peopleCulture.familyCulture)}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="קבוצות אתניות" items={data.peopleCulture.ethnicGroups} />
            <LabeledList title="שפות" items={data.peopleCulture.languages} />
            <LabeledList title="דתות" items={data.peopleCulture.religions} />
            <LabeledList title="מסורות" items={data.peopleCulture.traditions} />
            <LabeledList title="מנהגים" items={data.peopleCulture.customs} />
            <LabeledList title="ערכים לאומיים" items={data.peopleCulture.nationalValues} />
            <LabeledList title="פסטיבלים" items={data.peopleCulture.festivals} />
            <LabeledList title="חגים לאומיים" items={data.peopleCulture.nationalHolidays} />
          </div>

          {data.peopleCulture.traditionalClothing && (
            <div className="rounded-[24px] border border-border/70 bg-background/70 p-4">
              <h4 className="text-sm font-semibold text-foreground">לבוש מסורתי</h4>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                {data.peopleCulture.traditionalClothing}
              </p>
            </div>
          )}
        </div>
      </HubSection>

      <HubSection
        title="אוכל ושתייה"
        description="מה אוכלים, כמה זה עולה, איפה באמת שווה לאכול, ואיך להיכנס נכון לתרבות האוכל המקומית."
        icon={UtensilsCrossed}
      >
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="מנות לאומיות" items={data.foodGuide.nationalDishes} />
            <LabeledList title="אוכל רחוב" items={data.foodGuide.streetFood} />
            <LabeledList title="קינוחים מפורסמים" items={data.foodGuide.famousDesserts} />
            <LabeledList title="משקאות" items={data.foodGuide.drinks} />
            <LabeledList title="התמחויות מקומיות" items={data.foodGuide.localSpecialties} />
            <LabeledList title="נימוסי שולחן" items={data.foodGuide.foodEtiquette} />
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {valueLine("מחיר אוכל רחוב", data.foodGuide.typicalMealPrices.streetFood)}
            {valueLine("ארוחה רגילה", data.foodGuide.typicalMealPrices.casualMeal)}
            {valueLine("ארוחה זוגית", data.foodGuide.typicalMealPrices.dinnerForTwo)}
            {valueLine("ידידותי לצמחונים/טבעונים", data.foodGuide.vegetarianVeganFriendliness)}
          </div>

          {data.foodGuide.recommendedSpots.length > 0 && (
            <div className="space-y-4">
              <div>
                <h4 className="text-base font-semibold text-foreground">מקומות אוכל שכדאי לחפש</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  מסעדות, שווקים, רחובות אוכל ואזורים קולינריים שבאמת שווה לתכנן סביבם עצירה.
                </p>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {data.foodGuide.recommendedSpots.map((spot, index) => (
                  <FoodSpotCard key={`${spot.name}-${spot.cityOrArea}-${index}`} spot={spot} />
                ))}
              </div>
            </div>
          )}
        </div>
      </HubSection>

      <HubSection
        title="יעדים מובילים"
        description="עשרה מקומות שמייצגים היטב את המדינה ויכולים להרכיב טיול מצוין."
        icon={MapPinned}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.topDestinations.map((destination, index) => (
            <DestinationCard key={`${destination.name}-${index}`} destination={destination} />
          ))}
        </div>
      </HubSection>

      <HubSection
        title="אטרקציות מובילות"
        description="חלוקה לפי קטגוריות כדי שיהיה קל למצוא את סוג החוויה שמתאים לכם."
        icon={Landmark}
      >
        <div className="space-y-4">
          {data.topAttractions.map((group) => (
            <section key={group.category} className="rounded-[24px] border border-border/70 bg-background/60 p-4">
              <div className="mb-4 flex items-center gap-2">
                <Badge variant="secondary" className="rounded-full px-3 py-1">
                  {group.category}
                </Badge>
                <span className="text-sm text-muted-foreground">{group.attractions.length} מקומות בולטים</span>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {group.attractions.map((attraction, index) => (
                  <AttractionCard key={`${group.category}-${attraction.name}-${index}`} attraction={attraction} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </HubSection>

      <HubSection
        title="ערים מרכזיות"
        description="מה כדאי לדעת על הערים החשובות, לכמה זמן להישאר ומה לא לפספס בסביבה."
        icon={Landmark}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.cities.map((city, index) => (
            <article key={`${city.name}-${index}`} className="rounded-[24px] border border-border/70 bg-background/75 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-lg font-semibold text-foreground">{city.name}</h4>
                  {city.population && <p className="mt-1 text-sm text-muted-foreground">אוכלוסייה: {city.population}</p>}
                </div>
                {city.recommendedStay && <Badge variant="outline">{city.recommendedStay}</Badge>}
              </div>

              {city.knownFor && <p className="mt-4 text-sm leading-7 text-muted-foreground">{city.knownFor}</p>}

              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <LabeledList title="היילייטים" items={city.highlights} />
                <LabeledList title="אטרקציות קרובות" items={city.nearbyAttractions} />
              </div>
            </article>
          ))}
        </div>
      </HubSection>

      <HubSection
        title="רעיונות למסלולים"
        description="מסלולים מוכנים מראש למספרי ימים שונים, עם תחנות עיקריות ותכנון גס של לוגיסטיקה."
        icon={Route}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.itineraryIdeas.map((idea) => (
            <article key={`${idea.days}-${idea.title}`} className="rounded-[24px] border border-border/70 bg-background/75 p-5">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-lg font-semibold text-foreground">{idea.title || `${idea.days} ימים`}</h4>
                {idea.days > 0 && <Badge variant="secondary">{idea.days} ימים</Badge>}
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {valueLine("זמן נסיעות משוער", idea.estimatedTravelTime)}
                {valueLine("תקציב יומי", idea.dailyBudget)}
              </div>

              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <LabeledList title="מסלול" items={idea.route} />
                <LabeledList title="אטרקציות במסלול" items={idea.attractions} />
                <LabeledList title="מלונות מוצעים" items={idea.suggestedHotels} />
                <LabeledList title="מסעדות מוצעות" items={idea.restaurants} />
              </div>
            </article>
          ))}
        </div>
      </HubSection>

      <HubSection
        title="מתי הכי כדאי לבקר"
        description="סיכום עונתי מלא וגם פירוט חודשי לגבי מזג אוויר, עומס, מחירים ופעילויות מתאימות."
        icon={CalendarDays}
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {valueLine("סיכום עונתי", data.bestTime.summary)}
            {valueLine("העונה הטובה ביותר", data.bestTime.bestSeason)}
            {valueLine("העונה הזולה ביותר", data.bestTime.cheapestSeason)}
            {valueLine("עונה שפחות מומלצת", data.bestTime.avoidSeason)}
          </div>

          <ScrollArea className="w-full whitespace-nowrap rounded-[24px] border border-border/70">
            <div className="flex gap-4 p-4">
              {monthCards.map((month, index) => (
                <article
                  // Months should be 12 distinct values, but AI-generated
                  // content repeating one is still real data to render, not
                  // silently collapse — index keeps the key unique regardless.
                  key={`${month.month}-${index}`}
                  className="inline-flex w-[260px] shrink-0 flex-col rounded-[22px] border border-border/60 bg-background/75 p-4 align-top"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-base font-semibold text-foreground">{month.month}</h4>
                    {month.tourismLevel && <Badge variant="outline">{month.tourismLevel}</Badge>}
                  </div>
                  <div className="mt-4 space-y-3 text-sm">
                    {valueLine("מזג אוויר", month.weather)}
                    {valueLine("טמפרטורה ממוצעת", month.averageTemperature)}
                    {valueLine("גשם", month.rainfall)}
                    {valueLine("מחירים", month.prices)}
                  </div>
                  <div className="mt-4">
                    <h5 className="mb-2 text-sm font-semibold text-foreground">פעילויות מומלצות</h5>
                    <BulletList items={month.recommendedActivities} />
                  </div>
                </article>
              ))}
            </div>
          </ScrollArea>
        </div>
      </HubSection>

      <HubSection
        title="תחבורה"
        description="איך נכנסים למדינה, איך מתניידים בפנים ומה חשוב לדעת אם נוהגים בעצמכם."
        icon={Plane}
      >
        <div className="space-y-5">
          {data.transportation.airports.length > 0 && (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.transportation.airports.map((airport, index) => (
                <div key={`${airport.name}-${airport.city}-${index}`} className="rounded-[24px] border border-border/70 bg-background/75 p-4">
                  <h4 className="text-sm font-semibold text-foreground">{airport.name}</h4>
                  <p className="mt-1 text-sm text-muted-foreground">{airport.city}</p>
                  {airport.notes && <p className="mt-3 text-sm leading-6 text-muted-foreground">{airport.notes}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {valueLine("טיסות פנים", data.transportation.domesticFlights)}
            {valueLine("רכבות", data.transportation.trains)}
            {valueLine("מטרו/רכבת עירונית", data.transportation.metro)}
            {valueLine("אוטובוסים", data.transportation.buses)}
            {valueLine("מוניות", data.transportation.taxis)}
            {valueLine("אובר/בולט/חלופות", data.transportation.rideHailing)}
            {valueLine("השכרת רכב", data.transportation.carRental)}
            {valueLine("כללי נהיגה", data.transportation.drivingRules)}
            {valueLine("מחירי דלק", data.transportation.fuelPrices)}
            {valueLine("איכות כבישים", data.transportation.roadQuality)}
          </div>
        </div>
      </HubSection>

      <HubSection
        title="מדריך תקציב"
        description="השוואה מהירה בין טיול חסכוני, בינוני ויוקרתי כדי להבין סדרי גודל."
        icon={Wallet}
      >
        <div className="grid gap-4 xl:grid-cols-3">
          <BudgetTierCard title="תרמילאי" tier={data.budgetGuide.backpacker} />
          <BudgetTierCard title="בינוני" tier={data.budgetGuide.midRange} />
          <BudgetTierCard title="יוקרתי" tier={data.budgetGuide.luxury} />
        </div>
      </HubSection>

      <HubSection
        title="בטיחות"
        description="רמת בטיחות כללית, הונאות נפוצות, סיכונים טבעיים ומידע שימושי למטיילים עצמאיים."
        icon={Shield}
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {valueLine("ציון בטיחות", safetyScore)}
            {valueLine("רמת פשיעה", data.safety.crimeLevel)}
            {valueLine("טיול סולו", data.safety.soloTravelSafety)}
            {valueLine("בטיחות בלילה", data.safety.nightSafety)}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="הונאות תיירים" items={data.safety.touristScams} />
            <LabeledList title="שכונות/אזורים רגישים" items={data.safety.dangerousNeighborhoods} />
            <LabeledList title="אזורים בטוחים יותר" items={data.safety.safeNeighborhoods} />
            <LabeledList title="סיכונים טבעיים" items={data.safety.naturalHazards} />
            <LabeledList title="המלצות בריאות" items={data.safety.healthRecommendations} />
            <LabeledList title="מספרי חירום" items={data.safety.emergencyNumbers} />
          </div>

          {data.safety.womenSafety && (
            <div className="rounded-[24px] border border-border/70 bg-background/75 p-4">
              <h4 className="text-sm font-semibold text-foreground">בטיחות לנשים</h4>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{data.safety.womenSafety}</p>
            </div>
          )}
        </div>
      </HubSection>

      <HubSection
        title="מידע פרקטי"
        description="ויזה, מטבע, אינטרנט, חשמל, מים, רפואה וטיפים חשובים ליום הראשון במדינה."
        icon={Clock3}
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {valueLine("ויזה", data.practicalInformation.visaRequirements)}
            {valueLine("תוקף דרכון", data.practicalInformation.passportValidity)}
            {valueLine("מטבע", data.practicalInformation.currency)}
            {valueLine("אזור זמן", data.practicalInformation.timeZone)}
            {valueLine("סים / eSIM", data.practicalInformation.simCards)}
            {valueLine("איכות אינטרנט", data.practicalInformation.internetQuality)}
            {valueLine("שקעים וחשמל", data.practicalInformation.electricalPlugs)}
            {valueLine("מערכת בריאות", data.practicalInformation.healthcare)}
            {valueLine("בטיחות מים", data.practicalInformation.waterSafety)}
            {valueLine("מי ברז", data.practicalInformation.tapWater)}
            {valueLine("תרבות תשר", data.practicalInformation.tippingCulture)}
            {valueLine("חוקי עישון", data.practicalInformation.smokingLaws)}
            {valueLine("חוקי אלכוהול", data.practicalInformation.alcoholLaws)}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LabeledList title="טיפים להמרת כסף" items={data.practicalInformation.exchangeTips} />
            <LabeledList title="מספרי חירום" items={data.practicalInformation.emergencyNumbers} />
          </div>
        </div>
      </HubSection>
    </div>
  );
}
