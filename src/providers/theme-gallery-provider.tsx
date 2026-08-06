"use client";

import { useTheme as useNextTheme } from "next-themes";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { DEFAULT_THEME_ID, THEME_IDS, getThemeById, type ThemeId } from "@/lib/themes";

const STORAGE_KEY = "scratchmap-theme";
const TRANSITION_MS = 350;

interface ThemeGalleryContextValue {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  mounted: boolean;
}

const ThemeGalleryContext = createContext<ThemeGalleryContextValue | null>(null);

function applyThemeToDocument(id: ThemeId, animate: boolean) {
  const root = document.documentElement;

  if (animate) {
    root.classList.add("theme-transitioning");
    window.setTimeout(() => root.classList.remove("theme-transitioning"), TRANSITION_MS);
  }

  root.setAttribute("data-theme", id);
}

export function ThemeGalleryProvider({ children }: { children: React.ReactNode }) {
  const { setTheme: setNextTheme } = useNextTheme();
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [mounted, setMounted] = useState(false);

  // Restores the previously chosen theme on load (the inline script in
  // layout.tsx already painted it before hydration to avoid a flash — this
  // just syncs React state and next-themes' own dark/light class to match).
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const initialId = stored && (THEME_IDS as string[]).includes(stored) ? (stored as ThemeId) : DEFAULT_THEME_ID;
    setThemeIdState(initialId);
    setNextTheme(getThemeById(initialId).isDark ? "dark" : "light");
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setThemeId = useCallback(
    (id: ThemeId) => {
      applyThemeToDocument(id, true);
      setNextTheme(getThemeById(id).isDark ? "dark" : "light");
      setThemeIdState(id);
      window.localStorage.setItem(STORAGE_KEY, id);
    },
    [setNextTheme]
  );

  return (
    <ThemeGalleryContext.Provider value={{ themeId, setThemeId, mounted }}>{children}</ThemeGalleryContext.Provider>
  );
}

export function useThemeGallery() {
  const ctx = useContext(ThemeGalleryContext);
  if (!ctx) throw new Error("useThemeGallery must be used within ThemeGalleryProvider");
  return ctx;
}
