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
  accentColor?: string;
}

function FactTile({ icon: Icon, label, value, accentColor }: FactTileProps) {
  return (
    <div className="section-card flex h-full flex-col items-start gap-4 p-5 text-right">
      <div
        className="flex size-11 items-center justify-center rounded-2xl shadow-sm"
        style={{
          backgroundColor: accentColor ? `${accentColor}1A` : undefined,
          color: accentColor,
        }}
      >
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{value}</p>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

interface CountryQuickFactsProps {
  isoA2: string;
  className?: string;
  accentColor?: string;
}

export function CountryQuickFacts({ isoA2, className, accentColor }: CountryQuickFactsProps) {
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
  ].filter((tile) => Boolean(tile.value));

  return (
    <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6", className)}>
      {tiles.map((tile) => (
        <FactTile key={tile.label} {...tile} accentColor={accentColor} />
      ))}
    </div>
  );
}
