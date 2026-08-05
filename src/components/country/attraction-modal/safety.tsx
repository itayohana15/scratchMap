"use client";

import { ExternalLink, ShieldAlert } from "lucide-react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import { useCountryFacts } from "@/lib/facts/country-facts";

interface SafetySectionProps {
  isoA2: string;
}

// There is no free, reliable, place-level safety data source (general
// safety, night safety, scams, nearest hospital/police, emergency number),
// so we never fabricate one. This links out to real country-level sources
// instead of showing nothing.
export function SafetySection({ isoA2 }: SafetySectionProps) {
  const { data: facts, isError } = useCountryFacts(isoA2);
  if (isError || !facts) return null;

  const wikiSlug = encodeURIComponent(facts.englishName.replace(/ /g, "_"));

  return (
    <ModalSection title="בטיחות" icon={ShieldAlert}>
      <p className="text-sm text-muted-foreground">
        אין לנו מידע בטיחות ברמת האטרקציה הספציפית (בטיחות כללית, בטיחות בלילה, הונאות נפוצות, בית חולים או
        תחנת משטרה קרובים) ממקור פתוח ואמין, ולכן איננו ממציאים כזה. אלו מקורות כלליים למדינה:
      </p>
      <ul className="space-y-1.5">
        <li>
          <a
            href={`https://en.wikivoyage.org/wiki/${wikiSlug}#Stay_safe`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <ExternalLink className="size-3.5" />
            מידע לטיילים (&quot;Stay safe&quot;) — Wikivoyage
          </a>
        </li>
      </ul>
    </ModalSection>
  );
}
