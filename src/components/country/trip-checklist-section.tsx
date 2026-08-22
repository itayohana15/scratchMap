"use client";

import { CalendarClock, CheckCircle2, ClipboardList, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { bookings } from "@/lib/trip-bookings";
import {
  checklist,
  createUserChecklistItem,
  regenerateSmartChecklist,
  removeChecklistItem,
  syncChecklistCompletion,
  upcomingChecklistItems,
  upsertChecklistItem,
} from "@/lib/trip-checklist";
import { documents } from "@/lib/trip-documents";
import { CHECKLIST_CATEGORY_LABELS, type ChecklistCategory, type TripChecklistItem } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface TripChecklistSectionProps {
  draft: CountryItineraryRecord;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  isoA2: string;
}

export function TripChecklistSection({ draft, onPatchDraft, isoA2 }: TripChecklistSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const syncedChecklist = syncChecklistCompletion(checklist(draft), bookings(draft), documents(draft));
  const upcoming = upcomingChecklistItems(syncedChecklist);
  const allComplete = syncedChecklist.length > 0 && syncedChecklist.every((item) => item.completed);

  function patchItem(item: TripChecklistItem, patch: Partial<TripChecklistItem>) {
    upsertChecklistItem(onPatchDraft, { ...item, ...patch });
  }

  function handleAdd() {
    const item = createUserChecklistItem(draft.id);
    upsertChecklistItem(onPatchDraft, item);
    setEditingId(item.id);
  }

  const grouped = syncedChecklist.reduce<Record<string, TripChecklistItem[]>>((acc, item) => {
    acc[item.category] = acc[item.category] ?? [];
    acc[item.category].push(item);
    return acc;
  }, {});

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground">צ&apos;קליסט לפני הטיול</h3>
          <p className="text-sm text-muted-foreground">משימות אוטומטיות שזוהו מנתוני הטיול, בתוספת משימות אישיות.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => regenerateSmartChecklist(onPatchDraft, draft, isoA2)}>
            <RefreshCcw className="size-4" />
            רענן צ&apos;קליסט
          </Button>
          <Button size="sm" className="gap-1.5" onClick={handleAdd}>
            <Plus className="size-4" />
            הוסף משימה
          </Button>
        </div>
      </div>

      {upcoming.length > 0 ? (
        <div className="section-card space-y-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CalendarClock className="size-4 text-primary" />
            {upcoming.length} משימות דחופות
          </div>
          <ul className="space-y-1.5">
            {upcoming.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                <span>{item.title}</span>
                <span>יעד: {formatDate(item.dueDate)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {syncedChecklist.length === 0 ? (
        <div className="section-card flex flex-col items-center gap-2 p-8 text-center">
          <ClipboardList className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">אין עדיין משימות. לחצו על &quot;רענן צ&apos;קליסט&quot; כדי לזהות משימות אוטומטית.</p>
        </div>
      ) : allComplete ? (
        <div className="section-card flex flex-col items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-6 text-primary" />
          <p className="text-sm font-medium text-foreground">הכל מוכן!</p>
        </div>
      ) : null}

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{CHECKLIST_CATEGORY_LABELS[category as ChecklistCategory]}</p>
          <div className="space-y-2">
            {items.map((item) => {
              const isEditing = editingId === item.id;
              return (
                <div key={item.id} className="section-card flex items-start gap-3 p-3">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={item.completed}
                    aria-label={item.completed ? "סמן כלא הושלם" : "סמן כהושלם"}
                    onClick={() => patchItem(item, { completed: !item.completed })}
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border",
                      item.completed ? "border-primary bg-primary text-primary-foreground" : "border-border/70"
                    )}
                  >
                    {item.completed ? <CheckCircle2 className="size-3.5" /> : null}
                  </button>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {isEditing ? (
                      <Input value={item.title} onChange={(event) => patchItem(item, { title: event.target.value })} />
                    ) : (
                      <p className={cn("text-sm font-medium", item.completed ? "text-muted-foreground line-through" : "text-foreground")}>
                        {item.title || "משימה ללא כותרת"}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {item.source === "auto" ? <Badge variant="outline">זוהה אוטומטית</Badge> : null}
                      {item.dueDate ? <span>יעד: {formatDate(item.dueDate)}</span> : null}
                    </div>
                    {isEditing ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Select
                          value={item.category}
                          onValueChange={(value) => patchItem(item, { category: value as ChecklistCategory })}
                        >
                          <SelectTrigger size="sm">
                            <span>{CHECKLIST_CATEGORY_LABELS[item.category]}</span>
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(CHECKLIST_CATEGORY_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          type="date"
                          value={item.dueDate ?? ""}
                          onChange={(event) => patchItem(item, { dueDate: event.target.value || null })}
                          className="w-40"
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setEditingId(isEditing ? null : item.id)}>
                      {isEditing ? "סיום עריכה" : "עריכה"}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="מחיקת משימה"
                      onClick={() => removeChecklistItem(onPatchDraft, item.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
