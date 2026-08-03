"use client";

import { useState } from "react";
import { toast } from "sonner";

import { StatusSelect } from "@/components/shared/status-select";
import { useUpsertCountry } from "@/lib/queries/countries";
import type { Status } from "@/lib/supabase/types";

interface CountryAddCardProps {
  iso: string;
  name: string;
  iso3: string | null;
}

export function CountryAddCard({ iso, name, iso3 }: CountryAddCardProps) {
  const upsertCountry = useUpsertCountry();
  const [status, setStatus] = useState<Status>("planned");

  async function handleAdd(next: Status) {
    setStatus(next);
    try {
      await upsertCountry.mutateAsync({ name, iso_a2: iso.toUpperCase(), iso_a3: iso3, status: next });
      toast.success(`${name} נוספה לרשימה שלכם`);
    } catch {
      toast.error(`הוספת ${name} נכשלה`);
    }
  }

  return (
    <div className="glass-panel flex flex-col items-center gap-4 px-6 py-14 text-center">
      <h2 className="font-heading text-xl font-semibold">{name} עדיין לא ברשימה שלכם</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        סמנו כמבוקר או כמתוכנן כדי להתחיל לעקוב אחרי ערים, תמונות והערות.
      </p>
      <StatusSelect value={status} onChange={handleAdd} disabled={upsertCountry.isPending} />
    </div>
  );
}
