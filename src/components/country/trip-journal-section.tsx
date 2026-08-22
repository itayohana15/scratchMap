"use client";

import { Heart, NotebookPen, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

import { PhotoUploadDialog } from "@/components/gallery/photo-upload-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { photoPublicUrl, usePhotosForItinerary } from "@/lib/queries/photos";
import {
  attachPhotoToEntry,
  createEmptyJournalEntry,
  groupEntriesByCity,
  groupEntriesByDay,
  journalEntries,
  removeJournalEntry,
  upsertJournalEntry,
} from "@/lib/trip-journal";
import type { TripJournalEntry } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface TripJournalSectionProps {
  draft: CountryItineraryRecord;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
}

const NO_DAY_VALUE = "__none__";
const NO_ACTIVITY_VALUE = "__none__";

type GroupMode = "chronological" | "day" | "city";

function tripPhaseLabel(dayNumber: number, totalDays: number): string {
  if (totalDays <= 1) return "הטיול";
  const third = totalDays / 3;
  if (dayNumber <= third) return "תחילת הטיול";
  if (dayNumber <= third * 2) return "אמצע הטיול";
  return "סוף הטיול";
}

function dayLabelFor(draft: CountryItineraryRecord, dayId: string | null) {
  if (!dayId) return null;
  const day = draft.itineraryDays.find((item) => item.id === dayId);
  return day ? `יום ${day.dayNumber}` : null;
}

function EntryCard({
  entry,
  draft,
  isEditing,
  onToggleEdit,
  onPatch,
  onRemove,
}: {
  entry: TripJournalEntry;
  draft: CountryItineraryRecord;
  isEditing: boolean;
  onToggleEdit: () => void;
  onPatch: (patch: Partial<TripJournalEntry>) => void;
  onRemove: () => void;
}) {
  const [tagDraft, setTagDraft] = useState("");
  const { data: itineraryPhotos } = usePhotosForItinerary(isEditing ? draft.id : undefined);
  const attachedPhotos = (itineraryPhotos ?? []).filter((photo) => entry.photoIds.includes(photo.id));
  const availablePhotos = (itineraryPhotos ?? []).filter((photo) => !entry.photoIds.includes(photo.id));
  const dayItems = entry.dayId ? draft.itineraryDays.find((day) => day.id === entry.dayId)?.items ?? [] : [];

  function addTag() {
    const value = tagDraft.trim();
    if (!value || entry.tags.includes(value)) {
      setTagDraft("");
      return;
    }
    onPatch({ tags: [...entry.tags, value] });
    setTagDraft("");
  }

  return (
    <div className="section-card space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <Input
                value={entry.title}
                onChange={(event) => onPatch({ title: event.target.value })}
                placeholder="כותרת"
                className="font-medium"
              />
              <button
                type="button"
                onClick={() => onPatch({ favoriteMemory: !entry.favoriteMemory })}
                aria-label={entry.favoriteMemory ? "הסרה מזיכרונות אהובים" : "סמן כזיכרון אהוב"}
                className="shrink-0"
              >
                <Heart className={cn("size-5", entry.favoriteMemory ? "fill-destructive text-destructive" : "text-muted-foreground/40")} />
              </button>
            </div>
          ) : (
            <h4 className="flex items-center gap-1.5 font-medium text-foreground">
              {entry.favoriteMemory ? <Heart className="size-3.5 shrink-0 fill-destructive text-destructive" /> : null}
              {entry.title || "רשומה ללא כותרת"}
            </h4>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {entry.date ? <span>{formatDate(entry.date)}{entry.time ? ` · ${entry.time}` : ""}</span> : null}
            {dayLabelFor(draft, entry.dayId) ? <Badge variant="outline">{dayLabelFor(draft, entry.dayId)}</Badge> : null}
            {entry.city ? <span>{entry.city}</span> : null}
            {entry.place ? <span>· {entry.place}</span> : null}
            {entry.rating != null ? <Badge variant="secondary">{entry.rating}/10</Badge> : null}
            {entry.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px]">
                #{tag}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onToggleEdit}>
            {isEditing ? "סיום עריכה" : "עריכה"}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="מחיקת רשומה" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {isEditing ? (
        <div className="grid gap-3 border-t border-border/60 pt-3 md:grid-cols-2">
          <Textarea
            value={entry.text}
            onChange={(event) => onPatch({ text: event.target.value })}
            placeholder="מה קרה?"
            rows={4}
            className="md:col-span-2"
          />
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">יום בטיול</label>
            <Select
              value={entry.dayId ?? NO_DAY_VALUE}
              onValueChange={(value) => onPatch({ dayId: value === NO_DAY_VALUE ? null : value, activityId: null })}
            >
              <SelectTrigger size="sm" className="w-full">
                <span className="flex flex-1 truncate text-right">
                  {entry.dayId
                    ? (() => {
                        const day = draft.itineraryDays.find((item) => item.id === entry.dayId);
                        return day ? `יום ${day.dayNumber}${day.date ? ` · ${formatDate(day.date)}` : ""}` : "ללא יום מסוים";
                      })()
                    : "ללא יום מסוים"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DAY_VALUE}>ללא יום מסוים</SelectItem>
                {draft.itineraryDays.map((day) => (
                  <SelectItem key={day.id} value={day.id}>
                    יום {day.dayNumber} {day.date ? `· ${formatDate(day.date)}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">קשר לפעילות</label>
            <Select
              value={entry.activityId ?? NO_ACTIVITY_VALUE}
              onValueChange={(value) => onPatch({ activityId: value === NO_ACTIVITY_VALUE ? null : value })}
              disabled={!entry.dayId}
            >
              <SelectTrigger size="sm" className="w-full">
                <span className="truncate">
                  {dayItems.find((item) => item.id === entry.activityId)?.name || "ללא פעילות מסוימת"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACTIVITY_VALUE}>ללא פעילות מסוימת</SelectItem>
                {dayItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name || "פעילות ללא שם"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">תאריך</label>
            <Input type="date" value={entry.date ?? ""} onChange={(event) => onPatch({ date: event.target.value || null })} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">שעה</label>
            <Input type="time" value={entry.time} onChange={(event) => onPatch({ time: event.target.value })} />
          </div>
          <Input value={entry.city ?? ""} onChange={(event) => onPatch({ city: event.target.value || null })} placeholder="עיר" />
          <Input value={entry.place ?? ""} onChange={(event) => onPatch({ place: event.target.value || null })} placeholder="מקום" />
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">מצב רוח (1–5)</label>
            <Select value={entry.mood?.toString() ?? ""} onValueChange={(value) => onPatch({ mood: value ? Number(value) : null })}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5].map((n) => (
                  <SelectItem key={n} value={n.toString()}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">דירוג (1–10)</label>
            <Select value={entry.rating?.toString() ?? ""} onValueChange={(value) => onPatch({ rating: value ? Number(value) : null })}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
                  <SelectItem key={n} value={n.toString()}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">תגיות</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {entry.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="gap-1 text-[11px]">
                  #{tag}
                  <button type="button" onClick={() => onPatch({ tags: entry.tags.filter((t) => t !== tag) })} aria-label={`הסרת תגית ${tag}`}>
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              <Input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                placeholder="הוסף תגית ו-Enter"
                className="h-7 w-32 text-xs"
              />
            </div>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">תמונות</label>
            {attachedPhotos.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {attachedPhotos.map((photo) => (
                  <div key={photo.id} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoPublicUrl(photo.storage_path)} alt={photo.caption ?? ""} className="size-16 rounded-lg object-cover" />
                    <button
                      type="button"
                      onClick={() => onPatch({ photoIds: entry.photoIds.filter((id) => id !== photo.id) })}
                      aria-label="הסרת תמונה מהרשומה"
                      className="absolute -top-1.5 -left-1.5 flex size-5 items-center justify-center rounded-full bg-background/90 shadow"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <PhotoUploadDialog
                itineraryId={draft.id}
                dayId={entry.dayId}
                triggerLabel="הוסף תמונות חדשות"
                onUploaded={(photo) => onPatch({ photoIds: [...entry.photoIds, photo.id] })}
              />
              {availablePhotos.length > 0 ? (
                <Select
                  value=""
                  onValueChange={(photoId) => {
                    if (!photoId) return;
                    const nextEntry = attachPhotoToEntry(entry, photoId);
                    if (nextEntry.photoIds !== entry.photoIds) onPatch({ photoIds: nextEntry.photoIds });
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-40">
                    <span>בחר מתמונות הטיול</span>
                  </SelectTrigger>
                  <SelectContent>
                    {availablePhotos.map((photo) => (
                      <SelectItem key={photo.id} value={photo.id}>
                        {photo.caption || photo.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          </div>
        </div>
      ) : entry.text ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{entry.text}</p>
      ) : null}
    </div>
  );
}

export function TripJournalSection({ draft, onPatchDraft }: TripJournalSectionProps) {
  const entries = journalEntries(draft)
    .slice()
    .sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>("chronological");

  function handleAddEntry() {
    const entry = createEmptyJournalEntry();
    upsertJournalEntry(onPatchDraft, entry);
    setEditingId(entry.id);
  }

  function patchEntry(entry: TripJournalEntry, patch: Partial<TripJournalEntry>) {
    upsertJournalEntry(onPatchDraft, { ...entry, ...patch });
  }

  function renderEntry(entry: TripJournalEntry) {
    return (
      <EntryCard
        key={entry.id}
        entry={entry}
        draft={draft}
        isEditing={editingId === entry.id}
        onToggleEdit={() => setEditingId(editingId === entry.id ? null : entry.id)}
        onPatch={(patch) => patchEntry(entry, patch)}
        onRemove={() => removeJournalEntry(onPatchDraft, entry.id)}
      />
    );
  }

  const totalDays = draft.itineraryDays.length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground">יומן הטיול</h3>
          <p className="text-sm text-muted-foreground">
            מה באמת קרה, יום אחרי יום ומקום אחרי מקום.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={handleAddEntry}>
          <Plus className="size-4" />
          הוסף רשומה
        </Button>
      </div>

      {entries.length === 0 ? (
        <div className="section-card flex flex-col items-center gap-2 p-8 text-center">
          <NotebookPen className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">עדיין אין רשומות יומן לטיול הזה.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/60 p-1 self-start">
            {([
              { value: "chronological", label: "כרונולוגי" },
              { value: "day", label: "לפי יום" },
              { value: "city", label: "לפי עיר" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setGroupMode(option.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  groupMode === option.value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {groupMode === "chronological" ? (
            <div className="space-y-3">{entries.map(renderEntry)}</div>
          ) : groupMode === "day" ? (
            <div className="space-y-5">
              {groupEntriesByDay(entries, draft.itineraryDays).map((group) => {
                const day = draft.itineraryDays.find((d) => d.id === group.dayId);
                return (
                  <div key={group.dayId ?? "none"} className="space-y-2">
                    <h4 className="text-sm font-semibold text-foreground">
                      {group.label}
                      {day ? ` — ${day.cityRegion || ""} · ${tripPhaseLabel(day.dayNumber, totalDays)}` : ""}
                    </h4>
                    <div className="space-y-3">{group.entries.map(renderEntry)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-5">
              {groupEntriesByCity(entries).map((group) => (
                <div key={group.city} className="space-y-2">
                  <h4 className="text-sm font-semibold text-foreground">{group.city}</h4>
                  <div className="space-y-3">{group.entries.map(renderEntry)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
