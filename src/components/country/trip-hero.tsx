"use client";

import { CountryBanner } from "@/components/shared/country-banner";
import { formatDateRange } from "@/lib/format";
import { cn } from "@/lib/utils";

interface TripHeroProps {
  isoA2: string;
  countryName: string;
  tripTitle: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  citiesCount: number;
  placesCount: number;
  overallRating: number | null;
  favoritePhotoUrl?: string | null;
}

function HeroContent({
  isoA2,
  countryName,
  tripTitle,
  startDate,
  endDate,
  durationDays,
  citiesCount,
  placesCount,
  overallRating,
}: Omit<TripHeroProps, "favoritePhotoUrl">) {
  const flagUrl = `/flags/${isoA2.toLowerCase()}.png`;
  const dateLabel = formatDateRange(startDate, endDate);

  return (
    <div className="relative flex h-full w-full flex-col justify-end gap-2 p-4 text-white sm:p-6">
      <div className="flex items-center gap-3">
        <span className="overflow-hidden rounded-xl border border-white/25 shadow-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={flagUrl} alt={`דגל ${countryName}`} className="size-10 object-cover sm:size-12" />
        </span>
        <div>
          <h2 className="font-heading text-xl font-bold drop-shadow-sm sm:text-2xl">{countryName}</h2>
          {dateLabel ? <p className="text-sm text-white/85 drop-shadow-sm">{dateLabel}</p> : null}
        </div>
        {overallRating != null ? (
          <span className="mr-auto flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold backdrop-blur-sm">
            ⭐ {overallRating.toFixed(1)}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-white/90 drop-shadow-sm">{tripTitle}</p>
      <p className="text-sm text-white/80 drop-shadow-sm">
        {durationDays > 0 ? `${durationDays} ימים` : null}
        {durationDays > 0 && citiesCount > 0 ? " · " : null}
        {citiesCount > 0 ? `${citiesCount} ערים` : null}
        {(durationDays > 0 || citiesCount > 0) && placesCount > 0 ? " · " : null}
        {placesCount > 0 ? `${placesCount} מקומות` : null}
      </p>
    </div>
  );
}

export function TripHero(props: TripHeroProps) {
  if (props.favoritePhotoUrl) {
    return (
      <div className={cn("relative w-full overflow-hidden rounded-[28px] bg-muted", "min-h-[11rem] sm:min-h-[13rem]")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={props.favoritePhotoUrl} alt="" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
        <HeroContent {...props} />
      </div>
    );
  }

  return (
    <CountryBanner
      isoA2={props.isoA2}
      countryName={props.countryName}
      className="min-h-[11rem] w-full rounded-[28px] sm:min-h-[13rem]"
      showCaption={false}
      showFlagOverlay={false}
      overlay={<HeroContent {...props} />}
    />
  );
}
