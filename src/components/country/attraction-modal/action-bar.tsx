"use client";

import {
  Bookmark,
  BookmarkCheck,
  CircleCheck,
  ExternalLink,
  Navigation,
  Plus,
  Share2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AttractionActionBarProps {
  isSaved: boolean;
  isVisited: boolean;
  isInItinerary: boolean;
  mapSearchLink: string | null;
  directionsLink: string | null;
  shareTitle: string;
  onAddToItinerary: () => void;
  onToggleSave: () => void;
  onToggleVisited: () => void;
}

export function AttractionActionBar({
  isSaved,
  isVisited,
  isInItinerary,
  mapSearchLink,
  directionsLink,
  shareTitle,
  onAddToItinerary,
  onToggleSave,
  onToggleVisited,
}: AttractionActionBarProps) {
  async function handleShare() {
    const url = mapSearchLink ?? window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, url });
        return;
      } catch {
        // user cancelled the native share sheet — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("הקישור הועתק");
    } catch {
      toast.error("לא הצלחנו להעתיק את הקישור");
    }
  }

  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border/60 bg-background/95 p-3 backdrop-blur-xl sm:p-4">
      {!isInItinerary && (
        <Button className="gap-1.5" onClick={onAddToItinerary}>
          <Plus className="size-4" />
          הוסף למסלול
        </Button>
      )}

      {directionsLink && (
        <Button
          variant="outline"
          className="gap-1.5"
          nativeButton={false}
          render={<a href={directionsLink} target="_blank" rel="noreferrer" />}
        >
          <Navigation className="size-4" />
          נווט
        </Button>
      )}

      {mapSearchLink && (
        <Button
          variant="outline"
          className="gap-1.5"
          nativeButton={false}
          render={<a href={mapSearchLink} target="_blank" rel="noreferrer" />}
        >
          <ExternalLink className="size-4" />
          פתח במפות
        </Button>
      )}

      <Button variant="outline" className="gap-1.5" onClick={handleShare}>
        <Share2 className="size-4" />
        שיתוף
      </Button>

      <Button
        variant={isVisited ? "secondary" : "outline"}
        className={cn("gap-1.5", isVisited && "text-emerald-600 dark:text-emerald-400")}
        onClick={onToggleVisited}
      >
        <CircleCheck className="size-4" />
        בוצע ביקור
      </Button>

      <Button variant={isSaved ? "secondary" : "outline"} className="gap-1.5" onClick={onToggleSave}>
        {isSaved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
        מועדפים
      </Button>
    </div>
  );
}
