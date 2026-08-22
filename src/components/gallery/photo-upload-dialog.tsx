"use client";

import { ImagePlus, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUploadPhoto } from "@/lib/queries/photos";
import type { Tables } from "@/lib/supabase/types";

interface PhotoUploadDialogProps {
  countryId?: string;
  cityId?: string;
  itineraryId?: string;
  dayId?: string | null;
  placeId?: string | null;
  /** Fired once per successfully uploaded photo — lets a caller (e.g. a journal entry) link the new record without creating a second one. */
  onUploaded?: (photo: Tables<"photos">) => void;
  triggerLabel?: string;
}

export function PhotoUploadDialog({
  countryId,
  cityId,
  itineraryId,
  dayId,
  placeId,
  onUploaded,
  triggerLabel,
}: PhotoUploadDialogProps) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const [caption, setCaption] = useState("");
  const [takenAt, setTakenAt] = useState("");
  const uploadPhoto = useUploadPhoto();

  const uploading = uploadPhoto.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!files || files.length === 0) return;

    let succeeded = 0;
    for (const file of Array.from(files)) {
      try {
        const photo = await uploadPhoto.mutateAsync({
          file,
          countryId,
          cityId,
          itineraryId,
          dayId,
          placeId,
          caption: caption || undefined,
          takenAt: takenAt || undefined,
        });
        succeeded += 1;
        onUploaded?.(photo);
      } catch {
        toast.error(`העלאת ${file.name} נכשלה`);
      }
    }

    if (succeeded > 0) {
      toast.success(`${succeeded} תמונות הועלו בהצלחה`);
      setOpen(false);
      setFiles(null);
      setCaption("");
      setTakenAt("");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!uploading) setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="secondary" size="sm" className="gap-1.5">
            <ImagePlus className="size-4" />
            {triggerLabel ?? "הוספת תמונות"}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>הוספת תמונות</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="photo-files">תמונות</Label>
            <Input
              id="photo-files"
              type="file"
              accept="image/*"
              multiple
              required
              onChange={(e) => setFiles(e.target.files)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="photo-caption">כיתוב (יחול על כל התמונות)</Label>
            <Input
              id="photo-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="אופציונלי"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="photo-date">תאריך הצילום</Label>
            <Input
              id="photo-date"
              type="date"
              value={takenAt}
              onChange={(e) => setTakenAt(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={uploading} className="gap-1.5">
              {uploading && <Loader2 className="size-4 animate-spin" />}
              {uploading ? "מעלה…" : "העלאה"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
