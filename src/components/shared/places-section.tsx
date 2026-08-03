"use client";

import { Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeletePlace, usePlacesForCity, usePlacesForCountry, useUpsertPlace } from "@/lib/queries/places";
import type { PlaceKind } from "@/lib/supabase/types";

const KIND_LABELS: Record<PlaceKind, string> = {
  hotel: "מלון",
  restaurant: "מסעדה",
  attraction: "אטרקציה",
};

interface PlacesSectionProps {
  countryId?: string;
  cityId?: string;
  kind: PlaceKind;
  title: string;
  emptyHint?: string;
}

export function PlacesSection({ countryId, cityId, kind, title, emptyHint }: PlacesSectionProps) {
  const countryPlaces = usePlacesForCountry(cityId ? undefined : countryId, kind);
  const cityPlaces = usePlacesForCity(cityId, kind);
  const { data: places, isLoading } = cityId ? cityPlaces : countryPlaces;

  const upsertPlace = useUpsertPlace();
  const deletePlace = useDeletePlace();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await upsertPlace.mutateAsync({
        kind,
        name: name.trim(),
        address: address.trim() || null,
        country_id: countryId ?? null,
        city_id: cityId ?? null,
      });
      setName("");
      setAddress("");
      setShowForm(false);
    } catch {
      toast.error(`הוספת ${KIND_LABELS[kind]} נכשלה`);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setShowForm((s) => !s)}>
          <Plus className="size-4" />
          הוספה
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="glass-card flex flex-wrap items-end gap-2 p-3">
          <div className="min-w-[160px] flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">שם</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="min-w-[160px] flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">כתובת (אופציונלי)</label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={upsertPlace.isPending}>
            שמירה
          </Button>
        </form>
      )}

      {isLoading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : places && places.length > 0 ? (
        <ul className="space-y-2">
          {places.map((place) => (
            <li
              key={place.id}
              className="glass-card flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <div>
                <p className="text-sm font-medium">{place.name}</p>
                {place.address && (
                  <p className="text-xs text-muted-foreground">{place.address}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {place.rating != null && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Star className="size-3 fill-current" />
                    {place.rating}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => deletePlace.mutate(place)}
                  aria-label={`מחיקת ${place.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="glass-card px-4 py-8 text-center text-sm text-muted-foreground">
          {emptyHint ?? `לא נוספו פריטים מסוג ${KIND_LABELS[kind]} עדיין.`}
        </div>
      )}
    </section>
  );
}
