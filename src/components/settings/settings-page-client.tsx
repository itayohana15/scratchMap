"use client";

import { Palette, Plus, Search, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { ThemeCard } from "@/components/settings/theme-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  THEME_FILTERS,
  THEME_STYLE_TAGS,
  THEME_CATEGORIES,
  type ThemeFilterId,
} from "@/lib/themes/catalog";
import { THEMES, type ThemeDefinition } from "@/lib/themes";
import { applyThemePresentationToDocument } from "@/lib/themes/runtime";
import { useThemeGallery } from "@/providers/theme-gallery-provider";

const PREVIEW_SUPPORTED =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
    : false;

function matchesFilter(theme: ThemeDefinition, filter: ThemeFilterId) {
  switch (filter) {
    case "all":
      return true;
    case "light":
      return !theme.isDark;
    case "dark":
      return theme.isDark;
    case "nature":
      return THEME_CATEGORIES[theme.id] === "nature";
    case "colorful":
      return (THEME_STYLE_TAGS[theme.id] ?? []).includes("colorful");
    case "minimal":
      return (THEME_STYLE_TAGS[theme.id] ?? []).includes("minimal");
    default:
      return true;
  }
}

export function SettingsPageClient() {
  const { themeId, setThemeId, mounted } = useThemeGallery();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ThemeFilterId>("all");
  const previewedRef = useRef<string | null>(null);

  const previewTheme = useCallback((id: string) => {
    if (!PREVIEW_SUPPORTED || typeof document === "undefined") return;
    previewedRef.current = id;
    applyThemePresentationToDocument(id as typeof themeId, { animate: false });
  }, []);

  const clearPreview = useCallback(() => {
    if (!PREVIEW_SUPPORTED || typeof document === "undefined") return;
    if (previewedRef.current === null) return;
    previewedRef.current = null;
    applyThemePresentationToDocument(themeId, { animate: false });
  }, [themeId]);

  const grouped = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return CATEGORY_ORDER.map((category) => {
      const themes = THEMES.filter((theme) => {
        if (THEME_CATEGORIES[theme.id] !== category) return false;
        if (!matchesFilter(theme, filter)) return false;
        if (!normalizedQuery) return true;
        return (
          theme.name.toLowerCase().includes(normalizedQuery) ||
          theme.description.toLowerCase().includes(normalizedQuery)
        );
      });
      return { category, themes };
    }).filter((group) => group.themes.length > 0);
  }, [query, filter]);

  const hasResults = grouped.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <SettingsIcon className="size-7 text-primary" />
        <h1 className="font-heading text-2xl font-semibold">הגדרות</h1>
      </div>

      <section className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Palette className="size-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">ערכת נושא</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                בחרו ערכת נושא — הבחירה נשמרת ותיטען אוטומטית בפעם הבאה.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" disabled>
            <Plus className="size-4" />
            יצירת ערכה מותאמת אישית
          </Button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="חיפוש ערכת נושא"
              className="h-9 ps-8"
              aria-label="חיפוש ערכת נושא"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {THEME_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  filter === item.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-hover hover:text-foreground"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {!hasResults && (
          <p className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            לא נמצאו ערכות נושא התואמות את החיפוש.
          </p>
        )}

        {grouped.map(({ category, themes }) => (
          <div key={category} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-muted-foreground">{CATEGORY_LABELS[category]}</h3>
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">{themes.length}</span>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {themes.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  active={mounted && themeId === theme.id}
                  onSelect={() => setThemeId(theme.id)}
                  onPreviewStart={() => previewTheme(theme.id)}
                  onPreviewEnd={clearPreview}
                />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
