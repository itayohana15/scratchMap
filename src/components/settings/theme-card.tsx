"use client";

import { Check, Moon, Sun } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ThemeDefinition } from "@/lib/themes";
import { cn } from "@/lib/utils";

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((value) => value + value)
          .join("")
      : normalized;

  const value = Number.parseInt(expanded, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

interface ThemeCardProps {
  theme: ThemeDefinition;
  active: boolean;
  onSelect: () => void;
  onPreviewStart?: () => void;
  onPreviewEnd?: () => void;
}

export function ThemeCard({ theme, active, onSelect, onPreviewStart, onPreviewEnd }: ThemeCardProps) {
  const { background, swatches } = theme;
  const dots = [swatches.primary, swatches.secondary, swatches.accent, swatches.tertiary, swatches.quaternary].filter(
    (color): color is string => Boolean(color)
  );
  const previewTint = [
    `radial-gradient(circle at 18% 16%, ${hexToRgba(swatches.primary, theme.isDark ? 0.28 : 0.18)} 0%, transparent 42%)`,
    `radial-gradient(circle at 82% 78%, ${hexToRgba(swatches.accent, theme.isDark ? 0.24 : 0.14)} 0%, transparent 36%)`,
  ].join(", ");
  const previewImageOpacity = Math.max(
    background.previewOpacity ?? 0,
    Math.min(background.opacity * 2.8, theme.isDark ? 0.76 : 0.64)
  );
  const previewGlass = hexToRgba(swatches.card, theme.isDark ? 0.74 : 0.84);
  const previewBorder = hexToRgba(swatches.secondary, theme.isDark ? 0.82 : 0.94);
  const previewTrack = theme.isDark ? "rgba(255,255,255,0.9)" : "rgba(17,24,39,0.84)";
  const previewOverlay = theme.isDark
    ? "linear-gradient(180deg, rgba(10,12,18,0.08) 0%, rgba(10,12,18,0.02) 34%, rgba(10,12,18,0.34) 100%)"
    : "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.02) 38%, rgba(255,255,255,0.2) 100%)";
  const primaryLabelColor = theme.isDark ? "#09090b" : "#ffffff";

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onPreviewStart}
      onMouseLeave={onPreviewEnd}
      onFocus={onPreviewStart}
      onBlur={onPreviewEnd}
      aria-pressed={active}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card p-4 text-start transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg",
        active ? "border-primary" : "border-border hover:border-primary/40"
      )}
      style={
        active
          ? {
              boxShadow: `0 0 0 3px color-mix(in srgb, ${swatches.primary} 35%, transparent), 0 8px 28px -8px ${swatches.primary}`,
            }
          : undefined
      }
    >
      <span
        className="absolute end-3 top-3 z-10 flex size-6 items-center justify-center rounded-full border border-border/60 bg-card/90 text-muted-foreground shadow-sm backdrop-blur"
        title={theme.isDark ? "ערכה כהה" : "ערכה בהירה"}
      >
        {theme.isDark ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
      </span>

      {active && (
        <span className="absolute end-11 top-3 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check className="size-3.5" />
        </span>
      )}

      {/* Mini preview "window" */}
      <div
        className="relative h-40 overflow-hidden rounded-[1.35rem] border"
        style={{ backgroundColor: swatches.background, borderColor: swatches.secondary }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: swatches.background,
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `${previewTint}, url(${background.image})`,
            backgroundPosition: `center, ${background.previewPosition ?? background.position}`,
            backgroundSize: `cover, ${background.previewSize ?? background.size}`,
            backgroundRepeat: `no-repeat, ${background.repeat}`,
            opacity: previewImageOpacity,
            filter: theme.isDark ? "saturate(1.16) contrast(1.12)" : "saturate(1.08) contrast(1.04)",
            transform: "scale(1.03)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: previewOverlay,
          }}
        />
        <div className="relative z-[1] flex h-full flex-col justify-between p-3">
          <div className="flex items-start justify-between gap-2">
            <div
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium shadow-sm backdrop-blur-md"
              style={{ backgroundColor: previewGlass, borderColor: previewBorder, color: swatches.primary }}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: swatches.primary }} />
              {theme.isDark ? "כהה" : "בהיר"}
            </div>
            <div
              className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium shadow-sm backdrop-blur-md"
              style={{ backgroundColor: previewGlass, borderColor: previewBorder, color: swatches.accent }}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: swatches.accent }} />
              Accent
            </div>
          </div>

          <div className="space-y-2.5">
            <div
              className="w-[72%] rounded-[1rem] border px-3 py-2.5 shadow-sm backdrop-blur-md"
              style={{ backgroundColor: previewGlass, borderColor: previewBorder }}
            >
              <div className="space-y-2">
                <span className="block h-2.5 w-24 rounded-full" style={{ backgroundColor: previewTrack }} />
                <div className="flex items-center gap-2">
                  <span className="h-6 flex-1 rounded-lg" style={{ backgroundColor: swatches.primary }} />
                  <span className="size-6 rounded-full" style={{ backgroundColor: swatches.accent }} />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div
                className="flex h-7 min-w-22 items-center justify-center rounded-lg px-3 text-[10px] font-semibold shadow-sm"
                style={{ backgroundColor: swatches.primary }}
              >
                <span style={{ color: primaryLabelColor }}>Primary</span>
              </div>
              <div
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium shadow-sm backdrop-blur-md"
                style={{
                  backgroundColor: previewGlass,
                  borderColor: previewBorder,
                  color: swatches.primary,
                }}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: swatches.secondary }} />
                Surface
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-2">
        <p className="text-base font-semibold">{theme.name}</p>
        {active && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            פעיל
          </Badge>
        )}
      </div>
      <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{theme.description}</p>

      <div className="mt-3.5 flex items-center gap-2">
        {dots.map((color, index) => (
          <span
            key={index}
            className="size-5 rounded-full border border-black/10 dark:border-white/10"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </button>
  );
}
