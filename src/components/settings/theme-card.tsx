"use client";

import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ThemeDefinition } from "@/lib/themes";
import { cn } from "@/lib/utils";

interface ThemeCardProps {
  theme: ThemeDefinition;
  active: boolean;
  onSelect: () => void;
}

export function ThemeCard({ theme, active, onSelect }: ThemeCardProps) {
  const { swatches } = theme;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card p-3 text-start transition-all duration-300 hover:-translate-y-1 hover:shadow-lg",
        active ? "border-primary" : "border-border"
      )}
      style={
        active
          ? {
              boxShadow: `0 0 0 3px color-mix(in srgb, ${swatches.primary} 35%, transparent), 0 8px 28px -8px ${swatches.primary}`,
            }
          : undefined
      }
    >
      {active && (
        <span className="absolute end-3 top-3 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check className="size-3.5" />
        </span>
      )}

      {/* Mini preview "window" */}
      <div
        className="relative flex h-28 flex-col justify-end gap-1.5 overflow-hidden rounded-xl border p-2.5"
        style={{ backgroundColor: swatches.background, borderColor: swatches.secondary }}
      >
        <div
          className="h-9 w-full rounded-lg border p-1.5"
          style={{ backgroundColor: swatches.card, borderColor: swatches.secondary }}
        >
          <div className="flex h-full items-center gap-1.5">
            <span className="size-3 rounded-full" style={{ backgroundColor: swatches.primary }} />
            <span className="h-1.5 flex-1 rounded-full opacity-40" style={{ backgroundColor: swatches.accent }} />
          </div>
        </div>
        <div
          className="h-6 w-16 rounded-md"
          style={{ backgroundColor: swatches.primary }}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{theme.name}</p>
        {active && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            פעיל
          </Badge>
        )}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{theme.description}</p>

      <div className="mt-3 flex items-center gap-1.5">
        {[swatches.primary, swatches.secondary, swatches.accent].map((color, index) => (
          <span
            key={index}
            className="size-4 rounded-full border border-black/10 dark:border-white/10"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </button>
  );
}
