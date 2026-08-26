import type { Metadata } from "next";

import { WorldMap } from "@/components/map/world-map";

export const metadata: Metadata = { title: "מפה" };
export const dynamic = "force-dynamic";

export default function MapPage() {
  return (
    <main className="box-border flex w-full flex-col gap-2 px-3 py-2 sm:px-4">
      <div className="shrink-0 text-center">
        <h1 className="font-heading text-xl font-semibold sm:text-2xl">מפה</h1>
        <p className="text-xs text-muted-foreground sm:text-sm">
          חפשו מדינה מהצד הימני או לחצו עליה במפה כדי להתקרב ולראות את הערים שלה.
        </p>
      </div>
      {/*
        Fixed, viewport-derived height (not h-full/flex-1 chained from an
        ancestor, and never derived from sidebar/result content) so the map
        and sidebar keep identical physical dimensions regardless of how many
        search/filter results exist. calc(100vh - 180px) approximates the
        navbar (81px) + this title block + paddings; clamped so it never gets
        unreasonably short or tall.
      */}
      <div className="min-h-0 h-[clamp(540px,calc(100vh-180px),620px)] max-[899px]:h-[70vh]">
        <WorldMap />
      </div>
    </main>
  );
}
