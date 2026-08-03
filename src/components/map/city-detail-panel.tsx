"use client";

import { ArrowRight, MapPin } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { STATUS_LABELS } from "@/components/map/status-colors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { photoPublicUrl, usePhotosForCity } from "@/lib/queries/photos";
import { usePlacesForCity } from "@/lib/queries/places";
import type { Tables } from "@/lib/supabase/types";

interface CityDetailPanelProps {
  city: (Tables<"cities"> & { countryName?: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CityDetailPanel({ city, open, onOpenChange }: CityDetailPanelProps) {
  const { data: photos, isLoading: photosLoading } = usePhotosForCity(city?.id);
  const { data: attractions, isLoading: attractionsLoading } = usePlacesForCity(
    city?.id,
    "attraction"
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {city && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <MapPin className="size-4 text-primary" />
                <SheetTitle>{city.name}</SheetTitle>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {city.countryName && <span>{city.countryName}</span>}
                <Badge variant="secondary">{STATUS_LABELS[city.status]}</Badge>
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4">
              <section>
                <h3 className="mb-2 text-sm font-medium">תמונות</h3>
                {photosLoading ? (
                  <div className="grid grid-cols-3 gap-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="aspect-square rounded-lg" />
                    ))}
                  </div>
                ) : photos && photos.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {photos.slice(0, 6).map((photo) => (
                      <div key={photo.id} className="relative aspect-square overflow-hidden rounded-lg">
                        <Image
                          src={photoPublicUrl(photo.storage_path)}
                          alt={photo.caption ?? city.name}
                          fill
                          sizes="120px"
                          className="object-cover"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">אין עדיין תמונות.</p>
                )}
              </section>

              <Separator />

              <section>
                <h3 className="mb-2 text-sm font-medium">הערות</h3>
                <p className="text-sm text-muted-foreground">
                  {city.notes || "אין עדיין הערות."}
                </p>
              </section>

              <Separator />

              <section>
                <h3 className="mb-2 text-sm font-medium">אטרקציות</h3>
                {attractionsLoading ? (
                  <Skeleton className="h-12 rounded-lg" />
                ) : attractions && attractions.length > 0 ? (
                  <ul className="space-y-1.5 text-sm">
                    {attractions.map((place) => (
                      <li key={place.id} className="text-muted-foreground">
                        {place.name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    לא נוספו אטרקציות עדיין.
                  </p>
                )}
              </section>

              <Button
                variant="outline"
                className="w-full gap-2"
                nativeButton={false}
                render={<Link href={`/cities/${city.id}`} />}
              >
                צפייה בדף העיר המלא
                <ArrowRight className="size-4 rotate-180" />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
