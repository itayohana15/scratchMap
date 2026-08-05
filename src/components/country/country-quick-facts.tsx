"use client";

import { Coins, Globe2, Landmark, Languages, Ruler, Users } from "lucide-react";
import type { ComponentType } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useCountryFacts } from "@/lib/facts/country-facts";
import { cn } from "@/lib/utils";

function formatNumber(value: number | null) {
  if (value == null) return null;
  return new Intl.NumberFormat("he-IL").format(Math.round(value));
}

interface FactTileProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
}

function FactTile({ icon: Icon, label, value }: FactTileProps) {
  return (
    <div className="section-card flex flex-col items-center gap-2 p-5 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-5" />
      </div>
      <p className="text-sm font-semibold">{value ?? "—"}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface CountryQuickFactsProps {
  isoA2: string;
  className?: string;
}

export function CountryQuickFacts({ isoA2, className }: CountryQuickFactsProps) {
  const { data: facts, isLoading, isError } = useCountryFacts(isoA2);

  if (isError) return null;

  if (isLoading) {
    return (
      <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6", className)}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-[20px]" />
        ))}
      </div>
    );
  }

  if (!facts) return null;

  const tiles: FactTileProps[] = [
    { icon: Landmark, label: "בירה", value: facts.capital },
    { icon: Users, label: "אוכלוסייה", value: formatNumber(facts.population) },
    { icon: Coins, label: "מטבע", value: facts.currency },
    { icon: Languages, label: "שפה", value: facts.languages.length > 0 ? facts.languages.join(", ") : null },
    { icon: Ruler, label: "שטח", value: facts.area != null ? `${formatNumber(facts.area)} קמ״ר` : null },
    { icon: Globe2, label: "יבשת", value: facts.continent },
  ];

  return (
    <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6", className)}>
      {tiles.map((tile) => (
        <FactTile key={tile.label} {...tile} />
      ))}
    </div>
  );
}
