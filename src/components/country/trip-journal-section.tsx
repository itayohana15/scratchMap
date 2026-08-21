"use client";

import { NotebookPen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

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
import {
  createEmptyJournalEntry,
  journalEntries,
  removeJournalEntry,
  upsertJournalEntry,
} from "@/lib/trip-journal";
import type { TripJournalEntry } from "@/lib/trip-workspace";

interface TripJournalSectionProps {
  draft: CountryItineraryRecord;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
}

const NO_DAY_VALUE = "__none__";

export function TripJournalSection({ draft, onPatchDraft }: TripJournalSectionProps) {
  const entries = journalEntries(draft)
    .slice()
    .sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt));
  const [editingId, setEditingId] = useState<string | null>(null);

  function handleAddEntry() {
    const entry = createEmptyJournalEntry();
    upsertJournalEntry(onPatchDraft, entry);
    setEditingId(entry.id);
  }

  function patchEntry(entry: TripJournalEntry, patch: Partial<TripJournalEntry>) {
    upsertJournalEntry(onPatchDraft, { ...entry, ...patch });
  }

  function dayLabel(dayId: string | null) {
    if (!dayId) return null;
    const day = draft.itineraryDays.find((item) => item.id === dayId);
    return day ? `יום ${day.dayNumber}` : null;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
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
        <div className="space-y-3">
          {entries.map((entry) => {
            const isEditing = editingId === entry.id;
            return (
              <div key={entry.id} className="section-card space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    {isEditing ? (
                      <Input
                        value={entry.title}
                        onChange={(event) => patchEntry(entry, { title: event.target.value })}
                        placeholder="כותרת"
                        className="font-medium"
                      />
                    ) : (
                      <h4 className="font-medium text-foreground">{entry.title || "רשומה ללא כותרת"}</h4>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {entry.date ? <span>{formatDate(entry.date)}</span> : null}
                      {dayLabel(entry.dayId) ? <Badge variant="outline">{dayLabel(entry.dayId)}</Badge> : null}
                      {entry.city ? <span>{entry.city}</span> : null}
                      {entry.place ? <span>· {entry.place}</span> : null}
                      {entry.rating != null ? <Badge variant="secondary">{entry.rating}/10</Badge> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingId(isEditing ? null : entry.id)}
                    >
                      {isEditing ? "סיום עריכה" : "עריכה"}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="מחיקת רשומה"
                      onClick={() => removeJournalEntry(onPatchDraft, entry.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="grid gap-3 border-t border-border/60 pt-3 md:grid-cols-2">
                    <Textarea
                      value={entry.text}
                      onChange={(event) => patchEntry(entry, { text: event.target.value })}
                      placeholder="מה קרה?"
                      rows={4}
                      className="md:col-span-2"
                    />
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">יום בטיול</label>
                      <Select
                        value={entry.dayId ?? NO_DAY_VALUE}
                        onValueChange={(value) =>
                          patchEntry(entry, { dayId: value === NO_DAY_VALUE ? null : value })
                        }
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <span className="flex flex-1 truncate text-right">
                            {entry.dayId
                              ? (() => {
                                  const day = draft.itineraryDays.find((item) => item.id === entry.dayId);
                                  return day
                                    ? `יום ${day.dayNumber}${day.date ? ` · ${formatDate(day.date)}` : ""}`
                                    : "ללא יום מסוים";
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
                      <label className="text-xs font-medium text-muted-foreground">תאריך</label>
                      <Input
                        type="date"
                        value={entry.date ?? ""}
                        onChange={(event) =>
                          patchEntry(entry, { date: event.target.value || null })
                        }
                      />
                    </div>
                    <Input
                      value={entry.city ?? ""}
                      onChange={(event) => patchEntry(entry, { city: event.target.value || null })}
                      placeholder="עיר"
                    />
                    <Input
                      value={entry.place ?? ""}
                      onChange={(event) => patchEntry(entry, { place: event.target.value || null })}
                      placeholder="מקום"
                    />
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">מצב רוח (1–5)</label>
                      <Select
                        value={entry.mood?.toString() ?? ""}
                        onValueChange={(value) =>
                          patchEntry(entry, { mood: value ? Number(value) : null })
                        }
                      >
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
                      <Select
                        value={entry.rating?.toString() ?? ""}
                        onValueChange={(value) =>
                          patchEntry(entry, { rating: value ? Number(value) : null })
                        }
                      >
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
                  </div>
                ) : entry.text ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{entry.text}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
