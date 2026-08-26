import type { Metadata } from "next";

import { Navbar } from "@/components/layout/navbar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_IDS } from "@/lib/themes";
import { THEME_RUNTIME_DEFINITIONS } from "@/lib/themes/runtime";
import { QueryProvider } from "@/providers/query-provider";
import { ThemeGalleryProvider } from "@/providers/theme-gallery-provider";
import { ThemeProvider } from "@/providers/theme-provider";

import "./globals.css";

// Runs before hydration so the saved theme paints on the very first frame
// instead of flashing the default palette. The valid-id list is serialized
// from src/lib/themes/index.ts at render time, so it can never drift.
const THEME_INIT_SCRIPT = `(function(){try{var k="scratchmap-theme";var valid=${JSON.stringify(THEME_IDS)};var defs=${JSON.stringify(THEME_RUNTIME_DEFINITIONS)};var stored=localStorage.getItem(k);var id=valid.indexOf(stored)!==-1?stored:"arctic-light";var theme=defs[id]||defs["arctic-light"];var root=document.documentElement;root.setAttribute("data-theme",id);root.classList.toggle("dark",!!(theme&&theme.dark));if(theme&&theme.background){root.style.setProperty("--theme-background-image",'url("'+theme.background.image+'")');root.style.setProperty("--theme-background-position",theme.background.position);root.style.setProperty("--theme-background-mobile-position",theme.background.mobilePosition);root.style.setProperty("--theme-background-size",theme.background.size);root.style.setProperty("--theme-background-mobile-size",theme.background.mobileSize);root.style.setProperty("--theme-background-repeat",theme.background.repeat);root.style.setProperty("--theme-background-opacity",theme.background.opacity);root.style.setProperty("--theme-background-overlay",theme.background.overlay);root.style.setProperty("--theme-background-overlay-opacity",theme.background.overlayOpacity);root.style.setProperty("--theme-background-attachment",theme.background.attachment);var head=document.head;if(head&&theme.background.image){var link=document.getElementById("theme-background-preload");if(!link){link=document.createElement("link");link.id="theme-background-preload";link.rel="preload";link.as="image";head.appendChild(link);}link.href=theme.background.image;}}}catch(e){}})();`;

export const metadata: Metadata = {
  title: {
    default: "מפת גירוד",
    template: "%s · מפת גירוד",
  },
  description: "עקבו אחרי כל מדינה ועיר שביקרתם בהן, מתכננים לבקר, או חולמים להגיע אליהן.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ThemeGalleryProvider>
            <QueryProvider>
              <TooltipProvider>
                <Navbar />
                {/*
                  min-h-0 lets a page that wants to be exactly "the rest of
                  the viewport" (e.g. /map) size itself correctly against
                  this flex parent instead of guessing the navbar's real
                  height. Pages with naturally tall content are unaffected —
                  this doesn't clip anything, it just stops the default
                  flexbox min-height:auto from fighting a page that opts
                  into height:100%/overflow-hidden internally.
                */}
                <div className="min-h-0 flex-1">{children}</div>
                <Toaster />
              </TooltipProvider>
            </QueryProvider>
          </ThemeGalleryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
