"use client";

import { MapPin, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { STATUS_LABELS } from "@/components/map/status-colors";
import { CountryCitiesMap } from "@/components/country/country-cities-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCitiesByCountry, useUpsertCity } from "@/lib/queries/cities";

interface CountryCitiesSectionProps {
  countryId: string;
  countryName: string;
  iso: string;
}

export function CountryCitiesSection({ countryId, countryName, iso }: CountryCitiesSectionProps) {
  const { data: cities, isLoading } = useCitiesByCountry(countryId);
  const upsertCity = useUpsertCity();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await upsertCity.mutateAsync({
        country_id: countryId,
        name: name.trim(),
        latitude: latitude ? Number(latitude) : null,
        longitude: longitude ? Number(longitude) : null,
      });
      setName("");
      setLatitude("");
      setLongitude("");
      setShowForm(false);
    } catch {
      toast.error("הוספת העיר נכשלה — ייתכן שהשם כבר קיים במדינה הזו");
    }
  }

  return (
    <section className="flex min-h-full flex-col gap-3">
      <CountryCitiesMap countryId={countryId} countryName={countryName} iso={iso} />

      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">ערים</h2>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setShowForm((s) => !s)}>
          <Plus className="size-4" />
          הוספת עיר ידנית
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="section-card flex flex-wrap items-end gap-2 p-3">
          <div className="min-w-[140px] flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">שם</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="w-28 space-y-1">
            <label className="text-xs text-muted-foreground">קו רוחב</label>
            <Input value={latitude} onChange={(e) => setLatitude(e.target.value)} type="number" step="any" />
          </div>
          <div className="w-28 space-y-1">
            <label className="text-xs text-muted-foreground">קו אורך</label>
            <Input value={longitude} onChange={(e) => setLongitude(e.target.value)} type="number" step="any" />
          </div>
          <Button type="submit" size="sm" disabled={upsertCity.isPending}>
            שמירה
          </Button>
        </form>
      )}

      {isLoading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : cities && cities.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {cities.map((city) => (
            <li key={city.id}>
              <Link
                href={`/cities/${city.id}`}
                className="section-card flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <MapPin className="size-4 text-primary" />
                  {city.name}
                </span>
                <Badge variant="secondary">{STATUS_LABELS[city.status]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="section-card px-4 py-8 text-center text-sm text-muted-foreground">
          לא נוספו ערים עדיין.
        </div>
      )}
    </section>
  );
}
