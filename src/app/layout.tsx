import type { Metadata } from "next";

import { Navbar } from "@/components/layout/navbar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_IDS } from "@/lib/themes";
import { QueryProvider } from "@/providers/query-provider";
import { ThemeGalleryProvider } from "@/providers/theme-gallery-provider";
import { ThemeProvider } from "@/providers/theme-provider";

import "./globals.css";

// Runs before hydration so the saved theme paints on the very first frame
// instead of flashing the default palette. The valid-id list is serialized
// from src/lib/themes/index.ts at render time, so it can never drift.
const THEME_INIT_SCRIPT = `(function(){try{var k="scratchmap-theme";var valid=${JSON.stringify(THEME_IDS)};var stored=localStorage.getItem(k);var id=valid.indexOf(stored)!==-1?stored:"arctic-light";document.documentElement.setAttribute("data-theme",id);}catch(e){}})();`;

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
      <body className="min-h-screen bg-background font-sans antialiased">
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
                {children}
                <Toaster />
              </TooltipProvider>
            </QueryProvider>
          </ThemeGalleryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
