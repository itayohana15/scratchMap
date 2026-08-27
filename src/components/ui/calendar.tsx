"use client"

import * as React from "react"
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isEqual,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns"
import { he } from "date-fns/locale"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { findHolidayForDate, getHolidaysForYearRange, type HolidayCategory, type HolidayInfo } from "@/lib/facts/jewish-holidays"

export interface DateRange {
  from: Date | undefined
  to: Date | undefined
}

const WEEKDAY_LABELS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"]
const DAY_CELL_SIZE = "size-9" // 36px — within the compact 34-38px target.

// Small, subtle theme-toned dots — never filled-cell text — per spec item 28.
// A day can be both a Jewish holiday and an Israeli public holiday (e.g. Yom
// Kippur), in which case both dots render side by side.
const HOLIDAY_DOT_CLASS: Record<HolidayCategory, string> = {
  jewish_holiday: "bg-primary",
  israeli_public_holiday: "bg-chart-2",
}

const HOLIDAY_LEGEND: Array<{ category: HolidayCategory; label: string }> = [
  { category: "jewish_holiday", label: "חג יהודי" },
  { category: "israeli_public_holiday", label: "חג/מועד ישראלי" },
]

export function CalendarHolidayLegend() {
  return (
    <div dir="rtl" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {HOLIDAY_LEGEND.map(({ category, label }) => (
        <span key={category} className="flex items-center gap-1">
          <span className={cn("size-1.5 rounded-full", HOLIDAY_DOT_CLASS[category])} aria-hidden />
          {label}
        </span>
      ))}
    </div>
  )
}

function buildMonthGrid(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 0 })
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 0 })
  return eachDayOfInterval({ start, end })
}

interface CalendarMonthProps {
  month: Date
  range: DateRange
  hoverDate: Date | undefined
  onHoverChange: (date: Date | undefined) => void
  onSelectDay: (date: Date) => void
  disabled?: (date: Date) => boolean
  focusedDate: Date
  onFocusedDateChange: (date: Date) => void
  onHeaderClick: () => void
  holidays: HolidayInfo[]
}

function CalendarMonth({
  month,
  range,
  hoverDate,
  onHoverChange,
  onSelectDay,
  disabled,
  focusedDate,
  onFocusedDateChange,
  onHeaderClick,
  holidays,
}: CalendarMonthProps) {
  const days = React.useMemo(() => buildMonthGrid(month), [month])
  const previewEnd = range.from && !range.to ? hoverDate : undefined

  function dayState(day: Date) {
    const isDisabled = disabled?.(day) ?? false
    const isRangeStart = range.from && isSameDay(day, range.from)
    const isRangeEnd = range.to && isSameDay(day, range.to)
    const isInRange =
      range.from &&
      range.to &&
      (isAfter(day, range.from) || isEqual(day, range.from)) &&
      (isBefore(day, range.to) || isEqual(day, range.to))
    const isInPreview =
      previewEnd &&
      range.from &&
      !isBefore(previewEnd, range.from) &&
      (isAfter(day, range.from) || isEqual(day, range.from)) &&
      (isBefore(day, previewEnd) || isEqual(day, previewEnd))
    return { isDisabled, isRangeStart, isRangeEnd, isInRange, isInPreview }
  }

  function handleKeyDown(event: React.KeyboardEvent, day: Date) {
    const deltas: Record<string, number> = {
      ArrowLeft: 1,
      ArrowRight: -1,
      ArrowUp: -7,
      ArrowDown: 7,
    }
    const delta = deltas[event.key]
    if (delta != null) {
      event.preventDefault()
      onFocusedDateChange(addDays(day, delta))
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (!(disabled?.(day) ?? false)) onSelectDay(day)
    }
  }

  return (
    <div className="w-full">
      {/* The single, only header for this month — clicking it opens the year/month quick-picker (spec item 4/5: exactly one header, never repeated). */}
      <button
        type="button"
        onClick={onHeaderClick}
        className="mb-2 block w-full rounded-lg py-0.5 text-center text-base font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {format(month, "MMMM yyyy", { locale: he })}
      </button>
      <div dir="ltr" className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="pb-0.5 text-xs font-medium text-muted-foreground">
            {label}
          </span>
        ))}
        {days.map((day) => {
          const { isDisabled, isRangeStart, isRangeEnd, isInRange, isInPreview } = dayState(day)
          const isCurrentMonth = isSameMonth(day, month)
          const isFocused = isSameDay(day, focusedDate)
          const isEndpoint = isRangeStart || isRangeEnd
          const isFilled = isInRange || isInPreview
          const holiday = findHolidayForDate(holidays, format(day, "yyyy-MM-dd"))

          const dayButton = (
            <button
              type="button"
              role="gridcell"
              aria-selected={Boolean(isEndpoint)}
              aria-disabled={isDisabled}
              aria-label={holiday ? `${format(day, "d")} — ${holiday.nameHe}` : undefined}
              tabIndex={isFocused ? 0 : -1}
              disabled={isDisabled}
              onFocus={() => onFocusedDateChange(day)}
              onKeyDown={(event) => handleKeyDown(event, day)}
              onMouseEnter={() => onHoverChange(day)}
              onMouseLeave={() => onHoverChange(undefined)}
              onClick={() => onSelectDay(day)}
              className={cn(
                DAY_CELL_SIZE,
                "relative mx-auto flex items-center justify-center rounded-full text-sm transition-colors outline-none",
                !isCurrentMonth && "text-muted-foreground/35",
                isCurrentMonth && !isEndpoint && "text-foreground",
                !isDisabled && !isEndpoint && "hover:bg-accent hover:text-accent-foreground",
                isDisabled && "cursor-not-allowed text-muted-foreground/25",
                isEndpoint && "bg-primary font-semibold text-primary-foreground shadow-sm",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              )}
            >
              {format(day, "d")}
              {isToday(day) && !isEndpoint ? (
                <span className="absolute bottom-1 size-1 rounded-full bg-primary" aria-hidden />
              ) : null}
              {holiday ? (
                <span className="absolute -bottom-0.5 flex items-center gap-0.5" aria-hidden>
                  {holiday.categories.map((category) => (
                    <span key={category} className={cn("size-1 rounded-full", HOLIDAY_DOT_CLASS[category])} />
                  ))}
                </span>
              ) : null}
            </button>
          )

          return (
            <div
              key={day.toISOString()}
              className={cn(
                "relative",
                isFilled && "bg-primary/15",
                isRangeStart && (range.to || previewEnd) && "rounded-s-full",
                isRangeEnd && "rounded-e-full",
                isInPreview && !isRangeEnd && "rounded-e-full"
              )}
            >
              {holiday ? (
                <Tooltip>
                  <TooltipTrigger render={dayButton} />
                  <TooltipContent>
                    {holiday.nameHe} · {format(day, "d.M.yyyy")}
                  </TooltipContent>
                </Tooltip>
              ) : (
                dayButton
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface YearMonthPickerProps {
  viewMonth: Date
  onSelectMonth: (month: Date) => void
  onClose: () => void
}

function YearMonthPicker({ viewMonth, onSelectMonth, onClose }: YearMonthPickerProps) {
  const [year, setYear] = React.useState(viewMonth.getFullYear())
  const monthNames = React.useMemo(
    () => Array.from({ length: 12 }, (_, index) => format(new Date(2000, index, 1), "MMMM", { locale: he })),
    []
  )

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setYear((y) => y - 1)}
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="שנה קודמת"
        >
          <ChevronRight className="size-4" />
        </button>
        <span className="text-base font-semibold tabular-nums">{year}</span>
        <button
          type="button"
          onClick={() => setYear((y) => y + 1)}
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="שנה הבאה"
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {monthNames.map((name, index) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              onSelectMonth(new Date(year, index, 1))
              onClose()
            }}
            className={cn(
              "rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
              year === viewMonth.getFullYear() && index === viewMonth.getMonth()
                ? "bg-primary font-medium text-primary-foreground"
                : "text-foreground"
            )}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

export interface CalendarProps {
  range: DateRange
  onRangeChange: (range: DateRange) => void
  numberOfMonths?: 1 | 2
  disabled?: (date: Date) => boolean
  defaultMonth?: Date
}

/**
 * Hand-built on date-fns (already a project dependency) rather than adding
 * react-day-picker — no existing calendar/date-picker component was found
 * anywhere in the project to reuse. Every visual state uses theme tokens
 * only (bg-primary/bg-accent/text-muted-foreground/etc), never a hardcoded
 * color, so all 25 themes stay compatible automatically. Navigation arrows
 * are the only chrome in the top row — each month owns exactly one header
 * (clicking it opens the year/month quick-picker), never duplicated.
 */
export function Calendar({ range, onRangeChange, numberOfMonths = 1, disabled, defaultMonth }: CalendarProps) {
  const [viewMonth, setViewMonth] = React.useState(() => startOfMonth(defaultMonth ?? range.from ?? new Date()))
  const [hoverDate, setHoverDate] = React.useState<Date | undefined>(undefined)
  const [pickerOpenFor, setPickerOpenFor] = React.useState<0 | 1 | null>(null)
  const [focusedDate, setFocusedDate] = React.useState<Date>(() => startOfDay(range.from ?? new Date()))

  function handleSelectDay(day: Date) {
    const normalized = startOfDay(day)
    if (!range.from || (range.from && range.to)) {
      onRangeChange({ from: normalized, to: undefined })
      return
    }
    // Second click: reorder if earlier than the chosen start (the earlier
    // date always becomes the new start, per the preferred behavior).
    if (isBefore(normalized, range.from)) {
      onRangeChange({ from: normalized, to: undefined })
      return
    }
    onRangeChange({ from: range.from, to: normalized })
  }

  const secondMonth = addMonths(viewMonth, 1)
  const months = numberOfMonths === 2 ? [viewMonth, secondMonth] : [viewMonth]
  const holidays = React.useMemo(
    () => getHolidaysForYearRange(viewMonth.getFullYear(), secondMonth.getFullYear()),
    [viewMonth, secondMonth]
  )

  return (
    <div className="w-full select-none">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setViewMonth((m) => subMonths(m, 1))}
          className="flex size-9 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="חודש קודם"
        >
          <ChevronRight className="size-4.5" />
        </button>
        <button
          type="button"
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
          className="flex size-9 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="חודש הבא"
        >
          <ChevronLeft className="size-4.5" />
        </button>
      </div>

      {pickerOpenFor != null ? (
        <YearMonthPicker
          viewMonth={pickerOpenFor === 0 ? viewMonth : secondMonth}
          onSelectMonth={(month) => setViewMonth(pickerOpenFor === 0 ? month : subMonths(month, 1))}
          onClose={() => setPickerOpenFor(null)}
        />
      ) : (
        <div className={cn("grid gap-6", numberOfMonths === 2 && "sm:grid-cols-2")}>
          {months.map((month, index) => (
            <CalendarMonth
              key={month.toISOString()}
              month={month}
              range={range}
              hoverDate={hoverDate}
              onHoverChange={setHoverDate}
              onSelectDay={handleSelectDay}
              disabled={disabled}
              focusedDate={focusedDate}
              holidays={holidays}
              onHeaderClick={() => setPickerOpenFor(index === 0 ? 0 : 1)}
              onFocusedDateChange={(date) => {
                setFocusedDate(date)
                if (!isSameMonth(date, month) && index === 0) setViewMonth(startOfMonth(date))
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
