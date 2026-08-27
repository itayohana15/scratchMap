"use client";

import { ExternalLink, MapPinned, Route } from "lucide-react";
import { useTheme } from "next-themes";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import { usePlaceMiniMap } from "@/components/trips/activity-modal/use-place-mini-map";
import { Button } from "@/components/ui/button";
import { buildMapLink, type TripItineraryItem } from "@/lib/trip-workspace";

interface LocationSectionProps {
  item: TripItineraryItem;
  onShowOnDailyMap: () => void;
}

export function LocationSection({ item, onShowOnDailyMap }: LocationSectionProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { containerRef, ready } = usePlaceMiniMap({ isDark, lat: item.lat, lon: item.lon });

  const mapLink = item.mapLink || buildMapLink(item.name, item.lat, item.lon);

  return (
    <ModalSection title="מיקום" icon={MapPinned}>
      {item.location ? <p className="text-sm text-muted-foreground">{item.location}</p> : null}

      {item.lat != null && item.lon != null ? (
        <div className="relative h-40 w-full overflow-hidden rounded-xl border border-border/60">
          <div ref={containerRef} className="h-full w-full" />
          {!ready ? <div className="absolute inset-0 animate-pulse bg-muted" /> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" className="gap-1.5" onClick={onShowOnDailyMap}>
          <Route className="size-3.5" />
          הצג במסלול היומי
        </Button>
        {mapLink ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            nativeButton={false}
            render={<a href={mapLink} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink className="size-3.5" />
            פתח במפה
          </Button>
        ) : null}
      </div>
    </ModalSection>
  );
}
