"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpsertCountry } from "@/lib/queries/countries";
import type { Tables } from "@/lib/supabase/types";

interface CountryNotesSectionProps {
  country: Tables<"countries">;
}

export function CountryNotesSection({ country }: CountryNotesSectionProps) {
  const upsertCountry = useUpsertCountry();
  const [notes, setNotes] = useState(country.notes ?? "");
  const dirty = notes !== (country.notes ?? "");

  async function handleSave() {
    try {
      await upsertCountry.mutateAsync({ id: country.id, notes });
      toast.success("ההערות נשמרו");
    } catch {
      toast.error("שמירת ההערות נכשלה");
    }
  }

  return (
    <section className="section-card space-y-3 p-4">
      <h2 className="font-heading text-lg font-semibold">הערות אישיות</h2>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="כל מה שתרצו לזכור — טיפים לפעם הבאה, דברים להימנע מהם, לוגיסטיקה..."
        rows={8}
      />
      {dirty && (
        <Button size="sm" onClick={handleSave} disabled={upsertCountry.isPending}>
          שמירה
        </Button>
      )}
    </section>
  );
}
