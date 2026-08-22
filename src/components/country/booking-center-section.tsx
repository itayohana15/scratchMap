"use client";

import { Bus, Car, Ship, Ticket, TrainFront, Plane, Plus, Trash2, UtensilsCrossed, Wallet } from "lucide-react";
import { useState, type ComponentType } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useExchangeRates, COMMON_CURRENCIES } from "@/lib/currency/exchange-rates";
import { formatCurrency } from "@/lib/format";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { bookingSummary, bookings, createEmptyBooking, removeBooking, upsertBooking } from "@/lib/trip-bookings";
import {
  BOOKING_STATUS_LABELS,
  BOOKING_TYPE_LABELS,
  PAYMENT_STATUS_LABELS,
  type BookingStatus,
  type BookingType,
  type PaymentStatus,
  type TripBooking,
} from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface BookingCenterSectionProps {
  draft: CountryItineraryRecord;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  focusItemId?: string | null;
}

const NO_ITEM_VALUE = "__none__";

const BOOKING_TYPE_ICONS: Record<BookingType, ComponentType<{ className?: string }>> = {
  flight: Plane,
  accommodation: Wallet,
  train: TrainFront,
  bus: Bus,
  ferry: Ship,
  car_rental: Car,
  attraction: Ticket,
  restaurant: UtensilsCrossed,
  event: Ticket,
  tour: Ticket,
  other: Ticket,
};

function bookingStatusVariant(status: BookingStatus): "secondary" | "outline" | "destructive" {
  if (status === "booked" || status === "reserved") return "secondary";
  if (status === "cancelled") return "destructive";
  return "outline";
}

function paymentStatusVariant(status: PaymentStatus): "secondary" | "outline" {
  return status === "paid" ? "secondary" : "outline";
}

function AmountConverter({ booking, onChange }: { booking: TripBooking; onChange: (patch: Partial<TripBooking>) => void }) {
  const currency = booking.amountOriginalCurrency ?? "ILS";
  const { data: rates } = useExchangeRates(currency === "ILS" ? "ILS" : currency);

  function convert() {
    if (booking.amountOriginal == null) return;
    if (currency === "ILS") {
      onChange({ amountConverted: booking.amountOriginal, exchangeRate: 1, rateTimestamp: new Date().toISOString() });
      return;
    }
    const rate = rates?.rates?.ILS;
    if (rate == null) return;
    onChange({
      amountConverted: Math.round(booking.amountOriginal * rate * 100) / 100,
      exchangeRate: rate,
      rateTimestamp: rates?.updatedAt ?? new Date().toISOString(),
    });
  }

  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <Input
        type="number"
        value={booking.amountOriginal ?? ""}
        onChange={(event) => onChange({ amountOriginal: event.target.value ? Number(event.target.value) : null })}
        placeholder="סכום"
      />
      <Select
        value={currency}
        onValueChange={(value) => onChange({ amountOriginalCurrency: value })}
      >
        <SelectTrigger size="sm">
          <span>{currency}</span>
        </SelectTrigger>
        <SelectContent>
          {COMMON_CURRENCIES.map((entry) => (
            <SelectItem key={entry.code} value={entry.code}>
              {entry.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" size="sm" onClick={convert} disabled={booking.amountOriginal == null}>
        המר לש&quot;ח
      </Button>
      {booking.amountConverted != null ? (
        <p className="text-xs text-muted-foreground sm:col-span-3">
          שווה ערך: {formatCurrency(booking.amountConverted)}
        </p>
      ) : null}
    </div>
  );
}

export function BookingCenterSection({ draft, onPatchDraft, focusItemId }: BookingCenterSectionProps) {
  const bookingList = bookings(draft);
  const summary = bookingSummary(bookingList, draft.itineraryDays);
  const [editingId, setEditingId] = useState<string | null>(null);

  function handleAdd() {
    const booking = createEmptyBooking(draft.id);
    upsertBooking(onPatchDraft, booking);
    setEditingId(booking.id);
  }

  function patchBooking(booking: TripBooking, patch: Partial<TripBooking>) {
    upsertBooking(onPatchDraft, { ...booking, ...patch });
  }

  function itemLabel(itineraryItemId: string | null) {
    if (!itineraryItemId) return null;
    for (const day of draft.itineraryDays) {
      const item = day.items.find((entry) => entry.id === itineraryItemId);
      if (item) return `יום ${day.dayNumber} · ${item.name}`;
    }
    return null;
  }

  const grouped = bookingList.reduce<Record<string, TripBooking[]>>((acc, booking) => {
    acc[booking.type] = acc[booking.type] ?? [];
    acc[booking.type].push(booking);
    return acc;
  }, {});

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground">הזמנות</h3>
          <p className="text-sm text-muted-foreground">כל הטיסות, הלינות והכרטיסים של הטיול במקום אחד.</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={handleAdd}>
          <Plus className="size-4" />
          הוסף הזמנה
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{summary.total} הזמנות</Badge>
        <Badge variant={summary.needBooking > 0 ? "secondary" : "outline"}>{summary.needBooking} דרושה הזמנה</Badge>
        <Badge variant="outline">{summary.booked} הוזמנו</Badge>
        <Badge variant="outline">{summary.paid} שולמו</Badge>
        {summary.missing > 0 ? <Badge variant="destructive">{summary.missing} חסרות</Badge> : null}
      </div>

      {bookingList.length === 0 ? (
        <div className="section-card flex flex-col items-center gap-2 p-8 text-center">
          <Ticket className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">אין עדיין הזמנות לטיול הזה.</p>
        </div>
      ) : (
        Object.entries(grouped).map(([type, typeBookings]) => (
          <div key={type} className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">{BOOKING_TYPE_LABELS[type as BookingType]}</p>
            {typeBookings.map((booking) => {
              const isEditing = editingId === booking.id;
              const Icon = BOOKING_TYPE_ICONS[booking.type];
              const linkedLabel = itemLabel(booking.itineraryItemId);
              return (
                <div
                  key={booking.id}
                  className={cn(
                    "section-card space-y-3 p-4",
                    focusItemId && booking.itineraryItemId === focusItemId ? "border-primary/40 ring-1 ring-primary/20" : ""
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1 space-y-1">
                        {isEditing ? (
                          <Input
                            value={booking.title}
                            onChange={(event) => patchBooking(booking, { title: event.target.value })}
                            placeholder="שם ההזמנה"
                            className="font-medium"
                          />
                        ) : (
                          <h4 className="font-medium text-foreground">{booking.title || "הזמנה ללא שם"}</h4>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {booking.startDateTime ? <span>{booking.startDateTime}</span> : null}
                          {booking.provider ? <span>· {booking.provider}</span> : null}
                          {linkedLabel ? <Badge variant="outline">{linkedLabel}</Badge> : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={bookingStatusVariant(booking.status)}>
                            {BOOKING_STATUS_LABELS[booking.status]}
                          </Badge>
                          <Badge variant={paymentStatusVariant(booking.paymentStatus)}>
                            {PAYMENT_STATUS_LABELS[booking.paymentStatus]}
                          </Badge>
                          {booking.amountConverted != null ? (
                            <Badge variant="outline">{formatCurrency(booking.amountConverted)}</Badge>
                          ) : null}
                          {booking.confirmationNumber ? (
                            <span className="text-xs text-muted-foreground">אישור: {booking.confirmationNumber}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => setEditingId(isEditing ? null : booking.id)}>
                        {isEditing ? "סיום עריכה" : "עריכה"}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="מחיקת הזמנה"
                        onClick={() => removeBooking(onPatchDraft, booking.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="grid gap-3 border-t border-border/60 pt-3 md:grid-cols-2">
                      <Select
                        value={booking.type}
                        onValueChange={(value) => patchBooking(booking, { type: value as BookingType })}
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <span>{BOOKING_TYPE_LABELS[booking.type]}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(BOOKING_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={booking.status}
                        onValueChange={(value) => patchBooking(booking, { status: value as BookingStatus })}
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <span>{BOOKING_STATUS_LABELS[booking.status]}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(BOOKING_STATUS_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={booking.paymentStatus}
                        onValueChange={(value) => patchBooking(booking, { paymentStatus: value as PaymentStatus })}
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <span>{PAYMENT_STATUS_LABELS[booking.paymentStatus]}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={booking.itineraryItemId ?? NO_ITEM_VALUE}
                        onValueChange={(value) =>
                          patchBooking(booking, {
                            itineraryItemId: value === NO_ITEM_VALUE ? null : value,
                            dayId:
                              value === NO_ITEM_VALUE
                                ? null
                                : draft.itineraryDays.find((day) => day.items.some((item) => item.id === value))?.id ?? null,
                          })
                        }
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <span className="flex flex-1 truncate text-right">{linkedLabel ?? "ללא קישור לפעילות"}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_ITEM_VALUE}>ללא קישור לפעילות</SelectItem>
                          {draft.itineraryDays.map((day) =>
                            day.items.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                יום {day.dayNumber} · {item.name || "פעילות ללא שם"}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <Input
                        value={booking.provider}
                        onChange={(event) => patchBooking(booking, { provider: event.target.value })}
                        placeholder="ספק/חברה"
                      />
                      <Input
                        type="datetime-local"
                        value={booking.startDateTime}
                        onChange={(event) => patchBooking(booking, { startDateTime: event.target.value })}
                      />
                      <Input
                        type="datetime-local"
                        value={booking.endDateTime}
                        onChange={(event) => patchBooking(booking, { endDateTime: event.target.value })}
                      />
                      <Input
                        value={booking.location}
                        onChange={(event) => patchBooking(booking, { location: event.target.value })}
                        placeholder="מיקום"
                      />
                      <Input
                        value={booking.confirmationNumber}
                        onChange={(event) => patchBooking(booking, { confirmationNumber: event.target.value })}
                        placeholder="מספר אישור"
                      />
                      <Input
                        value={booking.bookingReference}
                        onChange={(event) => patchBooking(booking, { bookingReference: event.target.value })}
                        placeholder="קוד הזמנה"
                      />
                      <div className="md:col-span-2">
                        <AmountConverter booking={booking} onChange={(patch) => patchBooking(booking, patch)} />
                      </div>
                      <Textarea
                        value={booking.notes}
                        onChange={(event) => patchBooking(booking, { notes: event.target.value })}
                        placeholder="הערות"
                        rows={2}
                        className="md:col-span-2"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}
