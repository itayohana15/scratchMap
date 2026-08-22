"use client";

import Link from "next/link";

import type { CountryTripGroup } from "@/lib/travel-passport";
import { cn } from "@/lib/utils";

interface CountryStampCardProps {
  group: CountryTripGroup;
}

/** One card per ISO country — multiple visits show as multiple years inside ONE card (spec §27), never duplicated. */
export function CountryStampCard({ group }: CountryStampCardProps) {
  const flagUrl = `/flags/${group.isoA2.toLowerCase()}.png`;

  return (
    <Link
      href={`/countries/${group.isoA2.toLowerCase()}`}
      className={cn(
        "section-card flex flex-col items-center gap-2 p-4 text-center transition-transform duration-150 hover:-translate-y-0.5 hover:border-primary/40",
        group.isActive && "border-primary/50 ring-1 ring-primary/25"
      )}
    >
      <span className="overflow-hidden rounded-xl border border-border/60 shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={flagUrl} alt={`דגל ${group.countryName}`} className="size-14 object-cover" />
      </span>
      <p className="font-heading text-sm font-semibold text-foreground">{group.countryName}</p>
      <p className="text-xs text-muted-foreground">
        {group.visitYears.length > 0 ? group.visitYears.join(" · ") : group.isUpcoming ? "טיול קרוב" : ""}
      </p>
      {group.isActive ? <span className="text-[11px] font-medium text-primary">בטיול עכשיו</span> : null}
    </Link>
  );
}
