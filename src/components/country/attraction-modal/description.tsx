"use client";

import { BookOpen, ExternalLink } from "lucide-react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import type { WikipediaSummary } from "@/lib/wikipedia/summary";

interface DescriptionSectionProps {
  shortDescription: string;
  wikipedia: WikipediaSummary | null | undefined;
  wikipediaLoading: boolean;
}

// Reads as one real paragraph instead of a one-line blurb: the short intro
// (when we have one) followed by the actual Wikipedia extract, which is
// where any historical context comes from — we never write history
// ourselves, since we have no source for it. History / Highlights /
// Photography spots / Tips have no free data source today, so they simply
// aren't part of this text — add a real source later and it slots in here.
export function DescriptionSection({
  shortDescription,
  wikipedia,
  wikipediaLoading,
}: DescriptionSectionProps) {
  if (!shortDescription && !wikipediaLoading && !wikipedia) return null;

  return (
    <ModalSection title="על המקום" icon={BookOpen}>
      <div className="space-y-3 text-base leading-8 text-muted-foreground">
        {shortDescription && <p>{shortDescription}</p>}

        {wikipediaLoading && <p className="text-sm">טוען מידע מוויקיפדיה...</p>}

        {wikipedia && <p>{wikipedia.extract}</p>}
      </div>

      {wikipedia?.contentUrl && (
        <a
          href={wikipedia.contentUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" />
          קריאה מלאה בוויקיפדיה
        </a>
      )}
    </ModalSection>
  );
}
