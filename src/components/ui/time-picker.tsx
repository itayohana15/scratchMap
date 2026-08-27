"use client"

import * as React from "react"
import { Clock } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"))
const MINUTES = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, "0")) // 5-minute increments (spec item 9)

const QUICK_TIMES = [
  { label: "בוקר", time: "08:00" },
  { label: "צהריים", time: "13:00" },
  { label: "ערב", time: "18:00" },
  { label: "לילה", time: "22:00" },
]

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export interface TimePickerProps {
  value: string
  onChange: (time: string) => void
  placeholder?: string
}

/**
 * Theme-aware 24-hour time picker (spec items 7-11) — replaces the native
 * <input type="time"> spinner. Scrollable hour/minute columns plus a manual
 * text field for a precise value outside the 5-minute grid; every visual
 * state uses theme tokens only (bg-primary/bg-accent/border/etc).
 */
export function TimePicker({ value, onChange, placeholder }: TimePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [manualValue, setManualValue] = React.useState(value)
  const [hour, minute] = value ? value.split(":") : ["", ""]
  const hourListRef = React.useRef<HTMLDivElement>(null)
  const minuteListRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (open) setManualValue(value)
  }, [open, value])

  React.useEffect(() => {
    if (!open) return
    const scrollToSelected = (container: HTMLDivElement | null, selectedValue: string) => {
      if (!container) return
      const button = container.querySelector<HTMLButtonElement>(`[data-value="${selectedValue}"]`)
      button?.scrollIntoView({ block: "center" })
    }
    scrollToSelected(hourListRef.current, hour || "00")
    scrollToSelected(minuteListRef.current, minute || "00")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function setHour(nextHour: string) {
    onChange(`${nextHour}:${minute || "00"}`)
  }

  function setMinute(nextMinute: string) {
    onChange(`${hour || "00"}:${nextMinute}`)
  }

  function commitManualValue() {
    if (isValidTime(manualValue)) onChange(manualValue)
    else setManualValue(value)
  }

  const trigger = (
    <div
      role="button"
      tabIndex={0}
      className="flex h-11 w-full cursor-pointer items-center justify-between rounded-[16px] border border-input bg-background px-3.5 text-sm transition-colors hover:border-ring/50"
    >
      <span dir="ltr" className={value ? "font-medium text-foreground" : "text-muted-foreground"}>
        {value || placeholder || "בחרו שעה"}
      </span>
      <Clock className="size-4 text-muted-foreground" />
    </div>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} nativeButton={false} />
      <PopoverContent align="start" sideOffset={8} className="w-64 p-3">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_TIMES.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                onClick={() => {
                  onChange(shortcut.time)
                  setOpen(false)
                }}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
              >
                {shortcut.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div ref={hourListRef} className="h-40 overflow-y-auto rounded-lg border border-border">
              {HOURS.map((hourValue) => (
                <button
                  key={hourValue}
                  type="button"
                  data-value={hourValue}
                  onClick={() => setHour(hourValue)}
                  className={cn(
                    "block w-full px-2 py-1.5 text-center text-sm tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground",
                    hour === hourValue && "bg-primary font-semibold text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                  )}
                >
                  {hourValue}
                </button>
              ))}
            </div>
            <div ref={minuteListRef} className="h-40 overflow-y-auto rounded-lg border border-border">
              {MINUTES.map((minuteValue) => (
                <button
                  key={minuteValue}
                  type="button"
                  data-value={minuteValue}
                  onClick={() => setMinute(minuteValue)}
                  className={cn(
                    "block w-full px-2 py-1.5 text-center text-sm tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground",
                    minute === minuteValue && "bg-primary font-semibold text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                  )}
                >
                  {minuteValue}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">ערך מדויק</label>
            <input
              type="text"
              dir="ltr"
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              onBlur={commitManualValue}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitManualValue()
              }}
              placeholder="HH:MM"
              className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-center text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
