"use client";

import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect } from "react";

import { AirportCombobox } from "@/components/country/airport-combobox";
import { PreferenceField } from "@/components/country/trip-preferences-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TimePicker } from "@/components/ui/time-picker";
import {
  findAirportByIata,
  findAirportsForCountry,
  findDefaultAirportForCountry,
  getConnectionAirports,
  getIsraeliAirports,
} from "@/lib/facts/airports-data";
import { getCountryTimezone } from "@/lib/facts/country-timezones";
import { formatCurrency, formatDate } from "@/lib/format";
import { computeMultiSegmentFlight, HOME_TIMEZONE, type FlightSegmentResult } from "@/lib/flight-planning";
import {
  createEmptyFlightLeg,
  type FlightBookingStatus,
  type TripFlightConnection,
  type TripFlightLeg,
  type TripPreferences,
} from "@/lib/trip-workspace";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

function formatHoursMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

const FLIGHT_BOOKING_STATUS_LABELS: Record<FlightBookingStatus, string> = {
  not_booked: "לא הוזמן",
  booked: "הוזמן",
  paid: "שולם",
};

// Representative clock times for the "not booked yet" period picker (spec
// item 28) — the date always comes from the trip's own start/end date.
const ESTIMATED_PERIODS = ["morning", "afternoon", "evening", "night"] as const;
type EstimatedPeriod = (typeof ESTIMATED_PERIODS)[number];
const ESTIMATED_PERIOD_TIMES: Record<EstimatedPeriod, string> = {
  morning: "09:00",
  afternoon: "13:00",
  evening: "18:00",
  night: "22:00",
};
const ESTIMATED_PERIOD_LABELS: Record<EstimatedPeriod, string> = {
  morning: "בוקר",
  afternoon: "צהריים",
  evening: "ערב",
  night: "לילה",
};

function FlightLegCard({
  label,
  leg,
  isReturn,
  derivedDate,
  destinationIsoA2,
  onChange,
}: {
  label: string;
  leg: TripFlightLeg;
  isReturn: boolean;
  derivedDate: string;
  destinationIsoA2: string;
  onChange: (patch: Partial<TripFlightLeg>) => void;
}) {
  const destinationTimeZone = getCountryTimezone(destinationIsoA2);
  const departureFallbackTz = isReturn ? destinationTimeZone : HOME_TIMEZONE;
  const arrivalFallbackTz = isReturn ? HOME_TIMEZONE : destinationTimeZone;

  /**
   * Arrival is always deterministic — never asked of the AI (spec item 31).
   * Every segment (direct = one segment, connecting = one per hop) is
   * calculated independently and chained through any layovers (spec items
   * 17-21), unless the user has manually overridden the final arrival
   * (arrivalManuallySet), in which case their value is preserved until they
   * explicitly revert (spec item 6).
   */
  function withRecomputedArrival(nextLeg: TripFlightLeg): Partial<TripFlightLeg> {
    if (nextLeg.arrivalManuallySet) return {};
    if (!nextLeg.departureAirport || !nextLeg.arrivalAirport || !nextLeg.departureTime || !derivedDate) return {};

    const result = computeMultiSegmentFlight(
      nextLeg.departureAirport,
      nextLeg.arrivalAirport,
      derivedDate,
      nextLeg.departureTime,
      nextLeg.connections,
      departureFallbackTz,
      arrivalFallbackTz
    );
    if (!result) return {};

    return {
      arrivalDate: result.finalArrivalDate,
      arrivalTime: result.finalArrivalTime,
      // Airborne time only (spec item 12/38) — total door-to-door time,
      // including every layover, is tracked separately.
      estimatedFlightDurationMinutes: result.totalAirborneMinutes,
      totalJourneyMinutes: result.totalJourneyMinutes,
    };
  }

  function patch(fieldPatch: Partial<TripFlightLeg>) {
    const nextLeg = { ...leg, ...fieldPatch };
    onChange({ ...fieldPatch, ...withRecomputedArrival(nextLeg) });
  }

  function addConnection() {
    const nextConnections: TripFlightConnection[] = [...leg.connections, { airport: "", layoverMinutes: 90 }];
    patch({ connections: nextConnections });
  }

  function updateConnection(index: number, connectionPatch: Partial<TripFlightConnection>) {
    const nextConnections = leg.connections.map((connection, i) =>
      i === index ? { ...connection, ...connectionPatch } : connection
    );
    patch({ connections: nextConnections });
  }

  function removeConnection(index: number) {
    patch({ connections: leg.connections.filter((_, i) => i !== index) });
  }

  // Per-segment breakdown for display only (spec item 21/37) — recomputed
  // from the current leg state rather than stored, so it always matches
  // what's on screen even before the debounced patch() commits.
  const segmentDetails: FlightSegmentResult[] | null =
    leg.departureAirport && leg.arrivalAirport && leg.departureTime && derivedDate
      ? computeMultiSegmentFlight(
          leg.departureAirport,
          leg.arrivalAirport,
          derivedDate,
          leg.departureTime,
          leg.connections,
          departureFallbackTz,
          arrivalFallbackTz
        )?.segments ?? null
      : null;

  // Trip dates own the flight date (spec item 1) — never entered directly,
  // and kept in sync whenever Step 1's dates change, including on the
  // card's very first mount.
  useEffect(() => {
    if (!derivedDate || leg.departureDate === derivedDate) return;
    const nextLeg = { ...leg, departureDate: derivedDate };
    onChange({ departureDate: derivedDate, ...withRecomputedArrival(nextLeg) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedDate]);

  // TLV on the home side by default (spec items 7/8); the destination side
  // defaults to the trip's own country when a known airport exists there —
  // only seeded once, while the leg is still genuinely untouched.
  useEffect(() => {
    if (leg.departureAirport || leg.arrivalAirport) return;
    const destinationAirport = findDefaultAirportForCountry(destinationIsoA2)?.iata ?? "";
    onChange(
      isReturn
        ? { departureAirport: destinationAirport, arrivalAirport: "TLV" }
        : { departureAirport: "TLV", arrivalAirport: destinationAirport }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationIsoA2]);

  // If the trip's destination country changes after an airport was already
  // selected, clear whichever field is on the destination side once it no
  // longer belongs to the new country, and reseed it with the new
  // country's own default — never left silently pointing at the old
  // country (spec item 17, e.g. "Georgia → Japan: TBS must be removed
  // automatically"). Only the destination-side field is ever affected —
  // the Israel-side field never depends on which foreign country is picked.
  useEffect(() => {
    const currentIata = isReturn ? leg.departureAirport : leg.arrivalAirport;
    if (!currentIata) return;
    const airport = findAirportByIata(currentIata);
    if (airport && airport.countryIso.toUpperCase() === destinationIsoA2.toUpperCase()) return;
    const nextIata = findDefaultAirportForCountry(destinationIsoA2)?.iata ?? "";
    onChange(isReturn ? { departureAirport: nextIata } : { arrivalAirport: nextIata });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationIsoA2]);

  function setEstimated(estimated: boolean) {
    if (!estimated) {
      patch({ estimated: false });
      return;
    }
    const period: EstimatedPeriod = "morning";
    patch({ estimated: true, estimatedWindowStart: period, departureTime: ESTIMATED_PERIOD_TIMES[period] });
  }

  function revertArrivalToAuto() {
    const nextLeg = { ...leg, arrivalManuallySet: false };
    onChange({ arrivalManuallySet: false, ...withRecomputedArrival(nextLeg) });
  }

  const arrivesNextDay = Boolean(leg.arrivalDate && derivedDate && leg.arrivalDate > derivedDate);

  return (
    <div className="space-y-3 rounded-xl border border-border/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{formatDate(derivedDate, "d בMMMM yyyy") ?? "—"}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          עדיין לא הזמנתי טיסה
          <Switch checked={leg.estimated} onCheckedChange={setEstimated} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <PreferenceField label={isReturn ? "יציאה ממדינת היעד" : "יציאה מישראל"}>
          <AirportCombobox
            value={leg.departureAirport}
            onChange={(iata) => patch({ departureAirport: iata })}
            pool={isReturn ? findAirportsForCountry(destinationIsoA2) : getIsraeliAirports()}
          />
        </PreferenceField>
        <PreferenceField label={isReturn ? "נחיתה בישראל" : "נחיתה במדינת היעד"}>
          <AirportCombobox
            value={leg.arrivalAirport}
            onChange={(iata) => patch({ arrivalAirport: iata })}
            pool={isReturn ? getIsraeliAirports() : findAirportsForCountry(destinationIsoA2)}
          />
        </PreferenceField>
      </div>

      {leg.estimated ? (
        <PreferenceField label="טיסה משוערת">
          <Select
            value={leg.estimatedWindowStart || "morning"}
            onValueChange={(value) => {
              const period = (value ?? "morning") as EstimatedPeriod;
              patch({ estimatedWindowStart: period, departureTime: ESTIMATED_PERIOD_TIMES[period] });
            }}
          >
            <SelectTrigger>
              <span>{ESTIMATED_PERIOD_LABELS[(leg.estimatedWindowStart as EstimatedPeriod) || "morning"]}</span>
            </SelectTrigger>
            <SelectContent>
              {ESTIMATED_PERIODS.map((period) => (
                <SelectItem key={period} value={period}>
                  {ESTIMATED_PERIOD_LABELS[period]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PreferenceField>
      ) : (
        <PreferenceField label="שעת המראה">
          <TimePicker value={leg.departureTime} onChange={(time) => patch({ departureTime: time })} />
        </PreferenceField>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>{leg.connections.length === 0 ? "טיסה ישירה" : `${leg.connections.length} קונקשן${leg.connections.length > 1 ? "ים" : ""}`}</span>
          <Button type="button" variant="ghost" size="sm" className="gap-1 text-xs" onClick={addConnection}>
            <Plus className="size-3" />
            הוסף קונקשן
          </Button>
        </div>

        {leg.connections.map((connection, index) => (
          <div key={index} className="grid grid-cols-[1fr_auto_auto] items-end gap-2 rounded-lg border border-border/70 p-2.5">
            <PreferenceField label={`קונקשן ${index + 1}`}>
              {/* The one field allowed to show any country (spec item 6) —
                  only the leg's own endpoints are excluded, so a connection
                  can never be set to the same airport as the departure or
                  final destination. */}
              <AirportCombobox
                value={connection.airport}
                onChange={(iata) => updateConnection(index, { airport: iata })}
                pool={getConnectionAirports([leg.departureAirport, leg.arrivalAirport])}
              />
            </PreferenceField>
            <div className="w-24">
              <PreferenceField label="שהייה (דק')">
                <Input
                  type="number"
                  min={0}
                  value={connection.layoverMinutes}
                  onChange={(event) => updateConnection(index, { layoverMinutes: Number(event.target.value) || 0 })}
                />
              </PreferenceField>
            </div>
            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => removeConnection(index)}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="rounded-lg bg-muted/40 p-3 text-sm">
        {segmentDetails && segmentDetails.length > 1 ? (
          <div className="space-y-1.5">
            {segmentDetails.map((segment, index) => (
              <p key={index} className="text-muted-foreground">
                <bdi dir="ltr" className="font-medium text-foreground">
                  {segment.origin} → {segment.destination}
                </bdi>{" "}
                · {formatHoursMinutes(segment.durationMinutes)} שעות
                {index < segmentDetails.length - 1 ? (
                  <span className="mx-1">
                    · קונקשן {formatHoursMinutes(leg.connections[index]?.layoverMinutes ?? 0)}
                  </span>
                ) : null}
              </p>
            ))}
            <p className="border-t border-border/70 pt-1.5 text-muted-foreground">
              זמן באוויר: <span className="font-medium text-foreground">{formatHoursMinutes(leg.estimatedFlightDurationMinutes ?? 0)}</span>
              {" · "}
              זמן כולל: <span className="font-medium text-foreground">{formatHoursMinutes(leg.totalJourneyMinutes ?? 0)}</span>
            </p>
          </div>
        ) : leg.estimatedFlightDurationMinutes != null ? (
          <p className="text-muted-foreground">
            משך משוער: <span className="font-medium text-foreground">{formatHoursMinutes(leg.estimatedFlightDurationMinutes)} שעות</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            בחרו יציאה, יעד ושעת המראה כדי לחשב משך טיסה ונחיתה משוערת.
          </p>
        )}

        {leg.arrivalTime ? (
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              נחיתה משוערת:{" "}
              <span className="font-medium text-foreground">
                {arrivesNextDay ? `${formatDate(leg.arrivalDate, "d בMMM")} · ` : ""}
                {leg.arrivalTime}
                {arrivesNextDay ? " (+1)" : ""}
              </span>
              {leg.arrivalManuallySet ? <span className="mx-1 text-xs">(עודכן ידנית)</span> : null}
            </p>
            {leg.arrivalManuallySet ? (
              <Button type="button" variant="ghost" size="sm" className="gap-1 text-xs" onClick={revertArrivalToAuto}>
                <RotateCcw className="size-3" />
                חזרה לחישוב אוטומטי
              </Button>
            ) : null}
          </div>
        ) : null}

        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-primary [&::-webkit-details-marker]:hidden">
            <Pencil className="mx-1 inline size-3" />
            עריכת שעת נחיתה
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={leg.arrivalDate}
              onChange={(event) => onChange({ arrivalDate: event.target.value, arrivalManuallySet: true })}
            />
            <Input
              type="time"
              value={leg.arrivalTime}
              onChange={(event) => onChange({ arrivalTime: event.target.value, arrivalManuallySet: true })}
            />
          </div>
        </details>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <PreferenceField label="חברת תעופה ומספר טיסה (אופציונלי)">
          <div className="grid grid-cols-2 gap-2">
            <Input value={leg.airline} onChange={(event) => patch({ airline: event.target.value })} placeholder="El Al" />
            <Input
              value={leg.flightNumber}
              onChange={(event) => patch({ flightNumber: event.target.value })}
              placeholder="LY123"
            />
          </div>
        </PreferenceField>
        <PreferenceField label="עלות ומצב הזמנה">
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              value={leg.cost ?? ""}
              onChange={(event) => patch({ cost: event.target.value === "" ? null : Number(event.target.value) })}
              placeholder="₪"
            />
            <Select value={leg.bookingStatus} onValueChange={(value) => patch({ bookingStatus: value as FlightBookingStatus })}>
              <SelectTrigger>
                <span>{FLIGHT_BOOKING_STATUS_LABELS[leg.bookingStatus]}</span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FLIGHT_BOOKING_STATUS_LABELS).map(([value, statusLabel]) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PreferenceField>
      </div>
      {leg.cost != null && leg.cost > 0 ? (
        <p className="text-xs text-muted-foreground">{formatCurrency(leg.cost)}</p>
      ) : null}
    </div>
  );
}

/**
 * Dates are never entered here — they're derived from the trip's own
 * start/end date and kept in sync by the wizard root (spec items 1/10).
 * Airports default to TLV on the home side (spec items 7/8); the traveler
 * only enters departure time, arrival is always calculated (spec item 2).
 */
export function StepFlights({
  draft,
  destinationIsoA2,
  updatePreferences,
}: {
  draft: TripCreationDraft;
  destinationIsoA2: string;
  updatePreferences: (patch: Partial<TripPreferences>) => void;
}) {
  const flights = draft.preferences.flights;

  function patchOutbound(patch: Partial<TripFlightLeg>) {
    const current = flights?.outbound ?? createEmptyFlightLeg();
    updatePreferences({ flights: { outbound: { ...current, ...patch }, return: flights?.return ?? null } });
  }

  function patchReturn(patch: Partial<TripFlightLeg>) {
    const current = flights?.return ?? createEmptyFlightLeg();
    updatePreferences({ flights: { outbound: flights?.outbound ?? null, return: { ...current, ...patch } } });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        הזנת פרטי הטיסה עוזרת ל-AI לתכנן את היום הראשון והאחרון בצורה ריאלית — בלי פעילויות לפני שהגעתם בפועל וללא
        פעילויות אחרי שצריך לצאת לשדה. אופציונלי.
      </p>
      <FlightLegCard
        label="טיסת הלוך"
        leg={flights?.outbound ?? createEmptyFlightLeg()}
        isReturn={false}
        derivedDate={draft.preferences.startDate}
        destinationIsoA2={destinationIsoA2}
        onChange={patchOutbound}
      />
      <FlightLegCard
        label="טיסת חזור"
        leg={flights?.return ?? createEmptyFlightLeg()}
        isReturn
        derivedDate={draft.preferences.endDate}
        destinationIsoA2={destinationIsoA2}
        onChange={patchReturn}
      />
    </div>
  );
}
