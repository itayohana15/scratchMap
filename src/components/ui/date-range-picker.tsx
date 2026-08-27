"use client"

import * as React from "react"
import { addDays, format, parseISO, startOfDay } from "date-fns"

import { Button } from "@/components/ui/button"
import { Calendar, CalendarHolidayLegend, type DateRange } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { tripDurationDays } from "@/lib/format"

function useIsMobile(breakpointPx = 640) {
  const [isMobile, setIsMobile] = React.useState(false)
  React.useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`)
    setIsMobile(query.matches)
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches)
    query.addEventListener("change", handler)
    return () => query.removeEventListener("change", handler)
  }, [breakpointPx])
  return isMobile
}

function toIsoDate(date: Date): string {
  return format(date, "yyyy-MM-dd")
}

function fromIsoDate(value: string): Date | undefined {
  return value ? parseISO(value) : undefined
}

const START_SHORTCUTS = [
  { label: "היום", days: 0 },
  { label: "שבוע הבא", days: 7 },
  { label: "עוד חודש", days: 30 },
]
const DURATION_SHORTCUTS = [7, 10, 14, 21]

export interface DateRangePickerProps {
  startDate: string
  endDate: string
  onChange: (patch: { startDate: string; endDate: string }) => void
  /** Future-trip creation blocks past dates by default — pass false where historical dates are valid. */
  disablePast?: boolean
}

/**
 * Theme-aware trip date range picker — replaces the two native
 * <input type="date"> fields with a single shared range calendar built
 * entirely on theme tokens (bg-primary/bg-accent/border/etc), so it adapts
 * to all 25 themes automatically with zero calendar-specific colors.
 */
export function DateRangePicker({ startDate, endDate, onChange, disablePast = true }: DateRangePickerProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<DateRange>({
    from: fromIsoDate(startDate),
    to: fromIsoDate(endDate),
  })

  // Re-seed the draft from committed props each time the picker opens, and
  // discard an unconfirmed draft on close — "אישור" is the real commit;
  // escape/outside-click must not silently keep a stray edit.
  React.useEffect(() => {
    if (open) setDraft({ from: fromIsoDate(startDate), to: fromIsoDate(endDate) })
  }, [open, startDate, endDate])

  function handleOpenChange(next: boolean) {
    setOpen(next)
  }

  function handleConfirm() {
    onChange({
      startDate: draft.from ? toIsoDate(draft.from) : "",
      endDate: draft.to ? toIsoDate(draft.to) : "",
    })
    setOpen(false)
  }

  function handleClear() {
    setDraft({ from: undefined, to: undefined })
  }

  function applyStartShortcut(days: number) {
    setDraft({ from: startOfDay(addDays(new Date(), days)), to: undefined })
  }

  function applyDurationShortcut(days: number) {
    if (!draft.from) return
    setDraft({ from: draft.from, to: addDays(draft.from, days) })
  }

  const draftDurationDays =
    draft.from && draft.to ? tripDurationDays(toIsoDate(draft.from), toIsoDate(draft.to)) : null
  const today = startOfDay(new Date())
  // Which field the next click will fill — removes ambiguity (spec item 12).
  const activeField: "start" | "end" | null = !draft.from ? "start" : !draft.to ? "end" : null

  // Compact "26.8 → 5.9 · 11 ימים" line — the only date summary inside the
  // popup; the editable fields already showing full dates live in the
  // wizard above the trigger, so nothing here repeats them as cards. The
  // date range itself is forced LTR (bdi) so "26.8 → 5.9" always reads in
  // its natural left-to-right numeric order regardless of the page's RTL
  // context; "ימים" stays outside it as normal Hebrew text.
  const summary = draft.from ? (
    <>
      <bdi dir="ltr">
        {format(draft.from, "d.M")}
        {draft.to ? ` → ${format(draft.to, "d.M")}` : ""}
      </bdi>
      {draftDurationDays != null ? ` · ${draftDurationDays} ימים` : ""}
    </>
  ) : (
    "בחרו תאריך התחלה"
  )

  const body = (
    <div className="space-y-3 p-4">
      {activeField === "start" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {START_SHORTCUTS.map((shortcut) => (
            <button
              key={shortcut.label}
              type="button"
              onClick={() => applyStartShortcut(shortcut.days)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
            >
              {shortcut.label}
            </button>
          ))}
        </div>
      ) : activeField === "end" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {DURATION_SHORTCUTS.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => applyDurationShortcut(days)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
            >
              +{days} ימים
            </button>
          ))}
        </div>
      ) : null}

      <Calendar
        range={draft}
        onRangeChange={setDraft}
        numberOfMonths={isMobile ? 1 : 2}
        disabled={disablePast ? (date) => date < today : undefined}
        defaultMonth={draft.from}
      />

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <p className="truncate text-sm font-medium text-foreground">{summary}</p>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            נקה
          </button>
          <Button type="button" size="sm" onClick={handleConfirm} disabled={!draft.from || !draft.to}>
            אישור
          </Button>
        </div>
      </div>

      <CalendarHolidayLegend />
    </div>
  )

  const trigger = (
    <div
      role="button"
      tabIndex={0}
      className="grid cursor-pointer grid-cols-2 gap-3 rounded-[16px] border border-input bg-background transition-colors hover:border-ring/50"
    >
      <div className="flex flex-col gap-0.5 border-e border-border px-3.5 py-2.5">
        <span className="text-xs text-muted-foreground">תאריך התחלה</span>
        <span className="text-sm font-medium text-foreground">
          {startDate ? format(parseISO(startDate), "dd.MM.yyyy") : "בחרו תאריך"}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
        <span className="text-xs text-muted-foreground">תאריך סיום</span>
        <span className="text-sm font-medium text-foreground">
          {endDate ? format(parseISO(endDate), "dd.MM.yyyy") : "בחרו תאריך"}
        </span>
      </div>
    </div>
  )

  if (isMobile) {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)} className="block w-full text-start">
          {trigger}
        </button>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-3xl">
            {body}
          </SheetContent>
        </Sheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={trigger} nativeButton={false} />
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[min(620px,calc(100vw-3rem))] max-h-[min(500px,calc(100vh-7.5rem))] overflow-y-auto"
      >
        {body}
      </PopoverContent>
    </Popover>
  )
}
