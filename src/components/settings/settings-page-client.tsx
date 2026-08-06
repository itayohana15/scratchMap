"use client";

import { Palette, Plus, Settings as SettingsIcon } from "lucide-react";

import { ThemeCard } from "@/components/settings/theme-card";
import { Button } from "@/components/ui/button";
import { THEMES } from "@/lib/themes";
import { useThemeGallery } from "@/providers/theme-gallery-provider";

export function SettingsPageClient() {
  const { themeId, setThemeId, mounted } = useThemeGallery();

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <SettingsIcon className="size-7 text-primary" />
        <h1 className="font-heading text-2xl font-semibold">הגדרות</h1>
      </div>

      <section className="space-y-4">
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {THEMES.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              active={mounted && themeId === theme.id}
              onSelect={() => setThemeId(theme.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
