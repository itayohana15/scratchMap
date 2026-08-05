"use client";

import { Monitor, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const THEME_OPTIONS = [
  { value: "light", label: "בהיר", icon: Sun },
  { value: "dark", label: "כהה", icon: Moon },
  { value: "system", label: "לפי המערכת", icon: Monitor },
] as const;

export function SettingsPageClient() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <SettingsIcon className="size-7 text-primary" />
        <h1 className="font-heading text-2xl font-semibold">הגדרות</h1>
      </div>

      <section className="glass-card space-y-4 p-5">
        <div>
          <h2 className="text-lg font-semibold">מראה</h2>
          <p className="mt-1 text-sm text-muted-foreground">בחרו כיצד האפליקציה תיראה — בהיר, כהה, או לפי הגדרת המערכת שלכם.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEME_OPTIONS.map((option) => {
            const active = mounted && theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setTheme(option.value)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-2xl border px-4 py-5 text-sm font-medium transition-all",
                  active
                    ? "border-primary bg-primary/10 text-primary shadow-sm"
                    : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <option.icon className="size-6" />
                {option.label}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
