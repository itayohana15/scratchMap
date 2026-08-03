"use client";

import { CalendarCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StatusSelect } from "@/components/shared/status-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { useUpsertCity } from "@/lib/queries/cities";
import { useTripCitiesForCity } from "@/lib/queries/trips";
import type { Status, Tables } from "@/lib/supabase/types";

interface CityOverviewSectionProps {
  city: Tables<"cities">;
}

export function CityOverviewSection({ city }: CityOverviewSectionProps) {
  const upsertCity = useUpsertCity();
  const { data: visits } = useTripCitiesForCity(city.id);
  const [overview, setOverview] = useState(city.overview ?? "");
  const dirty = overview !== (city.overview ?? "");

  const arrivalDates = (visits ?? [])
    .map((v) => v.arrival_date)
    .filter((d): d is string => !!d)
    .sort();
  const firstVisit = arrivalDates[0];

  async function handleStatusChange(status: Status) {
    try {
      await upsertCity.mutateAsync({ id: city.id, country_id: city.country_id, name: city.name, status });
      toast.success("הסטטוס עודכן");
    } catch {
      toast.error("עדכון הסטטוס נכשל");
    }
  }

  async function handleSave() {
    try {
      await upsertCity.mutateAsync({ id: city.id, country_id: city.country_id, name: city.name, overview });
      toast.success("נשמר");
    } catch {
      toast.error("השמירה נכשלה");
    }
  }

  return (
    <div className="space-y-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm text-muted-foreground">סטטוס</p>
          <StatusSelect value={city.status} onChange={handleStatusChange} disabled={upsertCity.isPending} />
        </div>
        {firstVisit && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CalendarCheck className="size-4" />
            ביקור ראשון ב-{formatDate(firstVisit)}
          </div>
        )}
      </div>

      <div className="glass-card space-y-3 p-4">
        <label className="text-sm font-medium">סקירה כללית</label>
        <Textarea
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
          placeholder="איך העיר הזו?"
          rows={4}
        />
        {dirty && (
          <Button size="sm" onClick={handleSave} disabled={upsertCity.isPending}>
            שמירה
          </Button>
        )}
      </div>
    </div>
  );
}
