"use client";

import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DeleteTripDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tripName: string;
  /** Pre-formatted by the caller (e.g. formatTripDateRange) — this component never fetches or formats dates itself. */
  tripDates?: string | null;
  /** Pre-formatted, e.g. "44 ימים". */
  tripDuration?: string | null;
  onConfirm: () => Promise<void>;
}

/**
 * Replaces the old window.confirm("למחוק את המסלול מההיסטוריה?") flow with
 * a real, accessible modal — shared by every trip-delete entry point
 * (country page history list, the itinerary details dialog, the single
 * trip page, and the /trips hub cards) so there is exactly one
 * implementation of this confirmation, not one per surface.
 *
 * Owns its own isDeleting/error state rather than taking them as props:
 * every caller's `onConfirm` is just "run the mutation" — the shared
 * pending/error/success handling (including the fixed copy for both)
 * lives here once instead of being re-implemented at each call site.
 */
export function DeleteTripDialog({
  open,
  onOpenChange,
  tripName,
  tripDates,
  tripDuration,
  onConfirm,
}: DeleteTripDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasError, setHasError] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  async function handleConfirm() {
    if (isDeleting) return; // guards against a double-click starting two overlapping deletes
    setIsDeleting(true);
    setHasError(false);
    try {
      await onConfirm();
      toast.success("הטיול נמחק בהצלחה");
      setIsDeleting(false);
      onOpenChange(false);
    } catch {
      setIsDeleting(false);
      setHasError(true);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, eventDetails) => {
        // While a delete request is in flight, Escape/outside-click must
        // not silently close the dialog out from under it (spec §10).
        if (!next && isDeleting) {
          eventDetails.cancel();
          return;
        }
        if (!next) setHasError(false);
        onOpenChange(next);
      }}
    >
      {/* Some callers open this from inside an otherwise-clickable card row
          (portal content still bubbles clicks up the REACT tree even
          though it renders outside the card's DOM) — stopping propagation
          here matches the same guard this app's other dialogs already use
          in that exact situation. */}
      <AlertDialogContent
        initialFocus={cancelButtonRef}
        onClick={(event) => event.stopPropagation()}
        className="sm:max-w-[440px]"
      >
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>מחיקת הטיול</AlertDialogTitle>
          <AlertDialogDescription>
            האם למחוק את הטיול &quot;{tripName}&quot; מההיסטוריה?
          </AlertDialogDescription>
        </AlertDialogHeader>

        {tripDates || tripDuration ? (
          <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium text-foreground">{tripName}</p>
            <p className="text-muted-foreground">{[tripDates, tripDuration].filter(Boolean).join(" · ")}</p>
          </div>
        ) : null}

        <p className="text-xs leading-5 text-muted-foreground">
          הטיול, הימים, המלונות, ההעדפות והעריכות ששמרת יימחקו לצמיתות. לא ניתן לבטל את הפעולה לאחר המחיקה.
        </p>

        {hasError ? (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            לא הצלחנו למחוק את הטיול. נסו שוב.
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelButtonRef} disabled={isDeleting}>
            ביטול
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isDeleting} onClick={() => void handleConfirm()}>
            {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
            {isDeleting ? "מוחק..." : "מחק טיול"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
