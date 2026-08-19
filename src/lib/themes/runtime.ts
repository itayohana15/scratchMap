import { getThemeById, THEMES, type ThemeId } from "@/lib/themes";
import type { ThemeBackgroundDefinition } from "@/lib/themes/types";

const PRELOAD_LINK_ID = "theme-background-preload";

export interface SerializedThemeRuntimeDefinition {
  dark: boolean;
  background: {
    image: string;
    position: string;
    mobilePosition: string;
    size: string;
    mobileSize: string;
    repeat: string;
    opacity: string;
    overlay: string;
    overlayOpacity: string;
    attachment: string;
  };
}

function toCssValue(value: number | string | undefined, fallback: string) {
  return value == null ? fallback : String(value);
}

function serializeBackground(background: ThemeBackgroundDefinition) {
  return {
    image: background.image,
    position: background.position,
    mobilePosition: background.mobilePosition ?? background.position,
    size: background.size,
    mobileSize: background.mobileSize ?? background.size,
    repeat: background.repeat,
    opacity: toCssValue(background.opacity, "0.2"),
    overlay: background.overlay,
    overlayOpacity: toCssValue(background.overlayOpacity ?? 1, "1"),
    attachment: background.attachment ?? "scroll",
  };
}

export const THEME_RUNTIME_DEFINITIONS = Object.fromEntries(
  THEMES.map((theme) => [
    theme.id,
    {
      dark: theme.isDark,
      background: serializeBackground(theme.background),
    },
  ])
) as Record<ThemeId, SerializedThemeRuntimeDefinition>;

export function applyThemeBackgroundVariables(
  root: HTMLElement,
  background: ThemeBackgroundDefinition
) {
  root.style.setProperty("--theme-background-image", `url("${background.image}")`);
  root.style.setProperty("--theme-background-position", background.position);
  root.style.setProperty(
    "--theme-background-mobile-position",
    background.mobilePosition ?? background.position
  );
  root.style.setProperty("--theme-background-size", background.size);
  root.style.setProperty(
    "--theme-background-mobile-size",
    background.mobileSize ?? background.size
  );
  root.style.setProperty("--theme-background-repeat", background.repeat);
  root.style.setProperty("--theme-background-opacity", String(background.opacity));
  root.style.setProperty("--theme-background-overlay", background.overlay);
  root.style.setProperty(
    "--theme-background-overlay-opacity",
    String(background.overlayOpacity ?? 1)
  );
  root.style.setProperty(
    "--theme-background-attachment",
    background.attachment ?? "scroll"
  );
}

export function ensureThemeBackgroundPreload(image: string) {
  if (typeof document === "undefined") return;
  const head = document.head;
  if (!head) return;

  let link = document.getElementById(PRELOAD_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = PRELOAD_LINK_ID;
    link.rel = "preload";
    link.as = "image";
    head.appendChild(link);
  }

  if (link.href !== image) {
    link.href = image;
  }
}

export function applyThemePresentationToDocument(
  id: ThemeId,
  options?: { animate?: boolean; preload?: boolean }
) {
  const root = document.documentElement;
  const theme = getThemeById(id);

  if (options?.animate) {
    root.classList.add("theme-transitioning");
    window.setTimeout(() => root.classList.remove("theme-transitioning"), 350);
  }

  root.setAttribute("data-theme", id);
  root.classList.toggle("dark", theme.isDark);
  applyThemeBackgroundVariables(root, theme.background);

  if (options?.preload !== false) {
    ensureThemeBackgroundPreload(theme.background.image);
  }
}
