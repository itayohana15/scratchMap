"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useCountryPhoto } from "@/lib/photos/country-photo";
import { cn } from "@/lib/utils";

interface CountryBannerProps {
  isoA2: string;
  countryName: string;
  className?: string;
  showCaption?: boolean;
  overlay?: ReactNode;
  showFlagOverlay?: boolean;
  flagOverlayClassName?: string;
  scrimClassName?: string;
  imageAlt?: string;
}

export function CountryBanner({
  isoA2,
  countryName,
  className,
  showCaption = true,
  overlay,
  showFlagOverlay = true,
  flagOverlayClassName,
  scrimClassName,
  imageAlt,
}: CountryBannerProps) {
  const { data, isLoading, isError } = useCountryPhoto(isoA2);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const flagUrl = `/flags/${isoA2.toLowerCase()}.png`;

  return (
    <div className={cn("relative w-full overflow-hidden bg-muted", className)}>
      {data?.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.photoUrl}
          alt={imageAlt ?? `תמונת רקע של ${countryName}`}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-500",
            photoLoaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setPhotoLoaded(true)}
        />
      )}

      {isLoading && !isError && <Skeleton className="absolute inset-0 size-full rounded-none" />}

      {/*
        A wide (~half the banner) panel so the flag reads as equal in size to
        the photo, using bg-cover *within that box* so the fade below is a
        real color crossfade (the flag's own pixels dissolving into the
        photo) rather than a hard cut against empty transparent space.
      */}
      {showFlagOverlay && (
        <div
          className={cn("absolute inset-y-0 right-0 h-full w-[45%] bg-cover bg-center", flagOverlayClassName)}
          style={{
            backgroundImage: `url(${flagUrl})`,
            maskImage: "linear-gradient(to left, black 0%, black 60%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to left, black 0%, black 60%, transparent 100%)",
          }}
        />
      )}

      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-transparent",
          scrimClassName
        )}
      />

      {overlay && <div className="absolute inset-0 z-10">{overlay}</div>}

      {showCaption && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-2 p-4 sm:p-5">
          <h2 className="font-heading text-xl font-semibold text-white drop-shadow-sm">{countryName}</h2>
          {data?.photographer && (
            <a
              href={data.photographerUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-white/60 hover:text-white/90"
            >
              צילום: {data.photographer}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
