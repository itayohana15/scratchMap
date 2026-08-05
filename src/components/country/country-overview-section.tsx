"use client";

import { Star } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StatusSelect } from "@/components/shared/status-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpsertCountry } from "@/lib/queries/countries";
import type { Status, Tables } from "@/lib/supabase/types";

interface CountryOverviewSectionProps {
  country: Tables<"countries">;
  showStatus?: boolean;
}

export function CountryOverviewSection({
  country,
  showStatus = true,
}: CountryOverviewSectionProps) {
  const upsertCountry = useUpsertCountry();
  const [overview, setOverview] = useState(country.overview ?? "");
  const [favoriteMemory, setFavoriteMemory] = useState(country.favorite_memory ?? "");
  const dirty = overview !== (country.overview ?? "") || favoriteMemory !== (country.favorite_memory ?? "");

  async function handleStatusChange(status: Status) {
    try {
      await upsertCountry.mutateAsync({ id: country.id, status });
      toast.success("הסטטוס עודכן");
    } catch {
      toast.error("עדכון הסטטוס נכשל");
    }
  }

  async function handleSave() {
    try {
      await upsertCountry.mutateAsync({ id: country.id, overview, favorite_memory: favoriteMemory });
      toast.success("נשמר");
    } catch {
      toast.error("השמירה נכשלה");
    }
  }

  return (
    <div className="space-y-4">
      {showStatus && (
        <div className="section-card flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm text-muted-foreground">סטטוס</p>
            <StatusSelect value={country.status} onChange={handleStatusChange} disabled={upsertCountry.isPending} />
          </div>
          {country.rating != null && (
            <div className="flex items-center gap-1.5 text-sm">
              <Star className="size-4 fill-current text-amber-500" />
              {country.rating.toFixed(1)}
            </div>
          )}
        </div>
      )}

      <div className="section-card space-y-3 p-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">סקירה כללית</label>
          <Textarea
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            placeholder="איך המדינה הזו? רשמים ראשונים, נקודות שיא..."
            rows={4}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">זיכרון אהוב</label>
          <Textarea
            value={favoriteMemory}
            onChange={(e) => setFavoriteMemory(e.target.value)}
            placeholder="הרגע שתזכרו הכי הרבה"
            rows={3}
          />
        </div>
        {dirty && (
          <Button size="sm" onClick={handleSave} disabled={upsertCountry.isPending}>
            שמירה
          </Button>
        )}
      </div>
    </div>
  );
}
