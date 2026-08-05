"use client";

import { ExternalLink, ShieldAlert } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useCountryFacts } from "@/lib/facts/country-facts";

interface CountrySafetyInfoProps {
  isoA2: string;
}

// We deliberately do not compute or display a "safety score" — there is no
// free, reliable, global source for one, and inventing a number would be
// worse than not showing anything. Instead this links out to real,
// citable sources and tells the traveler to check their own country's
// official travel advisory.
export function CountrySafetyInfo({ isoA2 }: CountrySafetyInfoProps) {
  const { data: facts, isLoading, isError } = useCountryFacts(isoA2);

  if (isLoading) return <Skeleton className="h-40 rounded-[20px]" />;
  if (isError || !facts) return null;

  const wikiSlug = encodeURIComponent(facts.englishName.replace(/ /g, "_"));

  const links = [
    {
      label: "מידע כללי ומצב עדכני — Wikipedia",
      href: `https://en.wikipedia.org/wiki/${wikiSlug}`,
    },
    {
      label: 'מידע לטיילים ("Stay safe") — Wikivoyage',
      href: `https://en.wikivoyage.org/wiki/${wikiSlug}#Stay_safe`,
    },
  ];

  return (
    <div className="section-card space-y-3 p-6">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-5 text-amber-500" />
        <h3 className="text-lg font-semibold">בטיחות ומידע רשמי</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        אין לנו מקור פתוח ואמין לציון &quot;רמת בטיחות&quot; למדינה, ולכן אנחנו לא ממציאים אחד. לפני נסיעה מומלץ לבדוק
        את אזהרות הנסיעה העדכניות באתר הרשמי של משרד החוץ, ולהשלים עם המקורות הפתוחים הבאים.
      </p>

      <ul className="space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <ExternalLink className="size-3.5" />
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
