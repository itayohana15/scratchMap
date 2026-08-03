"use client";

import { STATUS_LABELS } from "@/components/map/status-colors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { Status } from "@/lib/supabase/types";

const OPTIONS: Status[] = ["not_visited", "planned", "visited"];

interface StatusSelectProps {
  value: Status;
  onChange: (status: Status) => void;
  disabled?: boolean;
}

export function StatusSelect({ value, onChange, disabled }: StatusSelectProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Status)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-40">
        <span className="flex flex-1 text-right">{STATUS_LABELS[value]}</span>
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((status) => (
          <SelectItem key={status} value={status}>
            {STATUS_LABELS[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
