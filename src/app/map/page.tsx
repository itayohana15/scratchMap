import type { Metadata } from "next";

import { WorldMap } from "@/components/map/world-map";

export const metadata: Metadata = { title: "מפה" };
export const dynamic = "force-dynamic";

export default function MapPage() {
  return (
    <main className="box-border flex h-[calc(100dvh-3.75rem)] min-h-0 w-full flex-col gap-3 overflow-hidden px-3 py-2 sm:px-4">
      <div className="shrink-0 text-center">
        <h1 className="font-heading text-2xl font-semibold">מפה</h1>
        <p className="text-sm text-muted-foreground">
          חפשו מדינה מהצד הימני או לחצו עליה במפה כדי להתקרב ולראות את הערים שלה.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <WorldMap />
      </div>
    </main>
  );
}
