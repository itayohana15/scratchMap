import { STATUS_COLORS, STATUS_LABELS } from "@/components/map/status-colors";
import type { Status } from "@/lib/supabase/types";

const ORDER: Status[] = ["visited", "planned", "not_visited"];

export function MapLegend() {
  return (
    <div className="glass-card pointer-events-auto flex items-center gap-4 px-4 py-2.5 text-sm">
      {ORDER.map((status) => (
        <div key={status} className="flex items-center gap-2">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: STATUS_COLORS[status].light }}
          />
          <span className="text-muted-foreground">{STATUS_LABELS[status]}</span>
        </div>
      ))}
    </div>
  );
}
