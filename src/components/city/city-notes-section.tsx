"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpsertCity } from "@/lib/queries/cities";
import type { Tables } from "@/lib/supabase/types";

interface CityNotesSectionProps {
  city: Tables<"cities">;
}

export function CityNotesSection({ city }: CityNotesSectionProps) {
  const upsertCity = useUpsertCity();
  const [notes, setNotes] = useState(city.notes ?? "");
  const dirty = notes !== (city.notes ?? "");

  async function handleSave() {
    try {
      await upsertCity.mutateAsync({ id: city.id, country_id: city.country_id, name: city.name, notes });
      toast.success("ההערות נשמרו");
    } catch {
      toast.error("שמירת ההערות נכשלה");
    }
  }

  return (
    <section className="glass-card space-y-3 p-4">
      <h2 className="font-heading text-lg font-semibold">הערות אישיות</h2>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="טיפים, מקומות אהובים, דברים לזכור..."
        rows={8}
      />
      {dirty && (
        <Button size="sm" onClick={handleSave} disabled={upsertCity.isPending}>
          שמירה
        </Button>
      )}
    </section>
  );
}
