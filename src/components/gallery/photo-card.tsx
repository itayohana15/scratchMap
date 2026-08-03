"use client";

import { Trash2 } from "lucide-react";
import Image from "next/image";

import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { photoPublicUrl } from "@/lib/queries/photos";
import type { Tables } from "@/lib/supabase/types";

interface PhotoCardProps {
  photo: Tables<"photos">;
  onView: () => void;
  onDelete: () => void;
  deleting?: boolean;
}

export function PhotoCard({ photo, onView, onDelete, deleting }: PhotoCardProps) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted">
      <button
        type="button"
        onClick={onView}
        className="absolute inset-0 h-full w-full cursor-zoom-in"
        aria-label={photo.caption ?? "צפייה בתמונה"}
      >
        <Image
          src={photoPublicUrl(photo.storage_path)}
          alt={photo.caption ?? ""}
          fill
          sizes="(min-width: 1024px) 220px, 33vw"
          className="object-cover transition-transform duration-300 group-hover:scale-105"
        />
      </button>

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100">
        <div className="pointer-events-auto flex justify-end p-1.5">
          <Button
            variant="secondary"
            size="icon-sm"
            className="bg-black/40 text-white hover:bg-black/60"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            disabled={deleting}
            aria-label="מחיקת תמונה"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        {(photo.caption || photo.taken_at) && (
          <div className="p-2 text-xs text-white">
            {photo.caption && <p className="line-clamp-1 font-medium">{photo.caption}</p>}
            {photo.taken_at && <p className="text-white/70">{formatDate(photo.taken_at)}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
