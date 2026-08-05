"use client";

import { Compass, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { MobileNav } from "@/components/layout/mobile-nav";
import { navLinks } from "@/components/layout/nav-links";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Navbar() {
  const pathname = usePathname();
  const hideNavbar = /^\/countries\/[^/]+$/.test(pathname);

  if (hideNavbar) {
    return null;
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <MobileNav />
          <Link href="/dashboard" className="flex items-center gap-2.5 font-heading text-xl font-semibold">
            <Compass className="size-7 text-primary" />
            <span>מפת גירוד</span>
          </Link>
          <nav className="hidden items-center gap-1.5 md:flex">
            {navLinks.map((link) => {
              const active = pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-4 py-2 text-base font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <link.icon className="size-5" />
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="הגדרות"
          nativeButton={false}
          className={cn(pathname.startsWith("/settings") && "bg-primary/10 text-primary")}
          render={<Link href="/settings" />}
        >
          <Settings className="size-5" />
        </Button>
      </div>
    </header>
  );
}
