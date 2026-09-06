import type {
  CountryTripWorkspaceState,
  RecommendationCategory,
  TripFlightLeg,
  TripItineraryDay,
  TripItineraryItem,
} from "@/lib/trip-workspace";
import { buildSuggestedItineraryTitle, type CountryItineraryRecord } from "@/lib/itineraries";
import { formatCurrency, formatDate, formatTripDateRange, formatTripDateRangeExpanded } from "@/lib/format";
import {
  computeDayGeographyDebugRow,
  computeGeoResolutionMatchSummary,
  type GeoResolutionOverrideMap,
} from "@/lib/itinerary-day-view-helpers";

/**
 * Rich, day-by-day PDF export for a saved itinerary — printed via the
 * browser's native "save as PDF" (window.print()) rather than a bundled PDF
 * library, matching this project's existing zero-new-dependency approach.
 * Shared by both the country page's itinerary history list and the /trips
 * dashboard's trip card menu, so both entry points produce an identical
 * export and any future improvement only needs to happen in one place.
 *
 * Every section is built strictly from real stored trip data (itinerary
 * days/items, flight legs, booking/safety notes already on the itinerary) —
 * nothing here is invented or templated placeholder text.
 */

const CATEGORY_EMOJI: Record<RecommendationCategory, string> = {
  attraction: "🏛️",
  restaurant: "🍽️",
  cafe: "☕",
  museum: "🖼️",
  nature: "🌿",
  shopping: "🛍️",
  nightlife: "🌙",
  family: "👨‍👩‍👧",
  hidden_gem: "💎",
  day_trip: "🚌",
  seasonal_event: "🎉",
  hotel: "🏨",
  transportation: "🚗",
  practical: "📋",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character];
  });
}

/**
 * Bidi-isolates a real entity name (a POI, a city, a hotel) so the browser
 * never reorders its own internal word order just because it sits inside
 * this RTL document — the exact bug behind "York New"/"Francisco San" in
 * a real exported PDF. `<bdi>` (not a hardcoded `dir="ltr"`) lets the
 * browser auto-detect the name's own real direction instead of assuming
 * every name is English — the underlying string itself is never touched,
 * only how it's isolated for rendering.
 */
export function bidiName(value: string): string {
  return `<bdi>${escapeHtml(value)}</bdi>`;
}

export function itineraryDisplayTitle(itinerary: CountryItineraryRecord, countryName: string): string {
  const title = itinerary.title.trim();
  if (!title) return countryName;

  const generatedTitles = new Set([
    buildSuggestedItineraryTitle(countryName, itinerary.startDate, itinerary.endDate),
    `${countryName}: ${formatTripDateRange(
      itinerary.startDate,
      itinerary.endDate,
      itinerary.preferencesSnapshot.partialDate
    )}`,
  ]);

  return generatedTitles.has(title) ? countryName : title;
}

function sortedItems(items: TripItineraryItem[]): TripItineraryItem[] {
  return [...items].sort((first, second) => {
    if (!first.plannedStartTime && !second.plannedStartTime) return 0;
    if (!first.plannedStartTime) return 1;
    if (!second.plannedStartTime) return -1;
    return first.plannedStartTime.localeCompare(second.plannedStartTime);
  });
}

export function renderItem(item: TripItineraryItem): string {
  const emoji = CATEGORY_EMOJI[item.category] ?? "•";
  const price = item.approximatePrice && item.approximatePrice > 0 ? formatCurrency(item.approximatePrice) : "";
  return `
    <li>
      <div class="item-head">
        <strong>${item.plannedStartTime ? `${escapeHtml(item.plannedStartTime)} · ` : ""}${emoji} ${bidiName(item.name)}</strong>
        ${price ? `<span class="price">${escapeHtml(price)}</span>` : ""}
      </div>
      ${item.location ? `<span class="location">${bidiName(item.location)}</span>` : ""}
      ${item.shortDescription ? `<p>${escapeHtml(item.shortDescription)}</p>` : ""}
      ${item.openingHours ? `<p class="meta">שעות פתיחה: ${escapeHtml(item.openingHours)}</p>` : ""}
      ${item.bookingWarning ? `<p class="warning">⚠ ${escapeHtml(item.bookingWarning)}</p>` : ""}
    </li>`;
}

function dayCostBreakdown(day: TripItineraryDay): string {
  const parts: Array<[string, number | null]> = [
    ["פעילויות", day.activityCost],
    ["אוכל", day.foodCost],
    ["תחבורה", day.transportCost],
    ["לינה", day.accommodationCost],
  ];
  const badges = parts
    .filter(([, value]) => value != null && value > 0)
    .map(([label, value]) => `<span class="cost-badge">${escapeHtml(label)}: ${escapeHtml(formatCurrency(value))}</span>`)
    .join("");
  if (!day.estimatedCost && !badges) return "";
  return `
    <div class="day-cost">
      ${day.estimatedCost != null ? `<span class="cost-total">עלות משוערת ליום: ${escapeHtml(formatCurrency(day.estimatedCost))}</span>` : ""}
      ${badges}
    </div>`;
}

/**
 * QA_DEBUG_GEOGRAPHY overlay for the PDF (the flag matters more here than
 * on the day screen — this is where real geography bugs actually get
 * found, per direct instruction). Same degraded, JIT-approximated
 * geoSource/derivedDayType as the day-screen panel — see
 * computeDayGeographyDebugRow's own note for exactly why. English field
 * values (geoSource/precision/dayType tokens) get the same bidiName()
 * isolation as every other English/foreign token in this RTL document, so
 * they don't get word-reordered the way plain names once did.
 */
export interface GeoDebugContext {
  previousDay: TripItineraryDay | null;
  isFirstDay: boolean;
  isLastDay: boolean;
  geoResolutionOverride: GeoResolutionOverrideMap | null;
}

function renderGeographyDebugSection(day: TripItineraryDay, context: GeoDebugContext): string {
  const row = computeDayGeographyDebugRow(
    day,
    context.previousDay,
    context.isFirstDay,
    context.isLastDay,
    "balanced",
    context.geoResolutionOverride
  );
  const itemRows = row.items
    .map(
      (it) => `<tr class="${
        it.geoSource === "unresolved" ? "geo-debug-unresolved" : it.geoSource === "unmatched" ? "geo-debug-unmatched" : ""
      }">
        <td>${bidiName(it.itemName)}</td>
        <td>${bidiName(it.category)}</td>
        <td>${bidiName(it.geoSource)}</td>
        <td>${bidiName(it.precision)}</td>
        <td>${it.legMinutes ?? "—"}</td>
      </tr>`
    )
    .join("");

  return `
    <div class="geo-debug">
      <p class="geo-debug-title">🔧 QA_DEBUG_GEOGRAPHY — יום ${row.dayNumber}</p>
      <p>derivedDayType=${bidiName(row.derivedDayType)} · textualDayType=${bidiName(row.textualDayType)} · ${
        row.dayTypeMismatch
          ? '<strong class="geo-debug-mismatch">dayTypeMismatch=TRUE</strong>'
          : "dayTypeMismatch=false"
      }</p>
      <p>totalLegMinutes=${row.totalLegMinutes} · maxLegMinutes=${row.maxLegMinutes} · unresolvedItemCount=${row.unresolvedItemCount}</p>
      ${
        itemRows
          ? `<table class="geo-debug-table"><thead><tr><th>item</th><th>category</th><th>geoSource</th><th>precision</th><th>legMinutes</th></tr></thead><tbody>${itemRows}</tbody></table>`
          : ""
      }
    </div>`;
}

export function renderDay(day: TripItineraryDay, geoDebugContext?: GeoDebugContext): string {
  const weekday = formatDate(day.date, "EEEE");
  const dateLabel = formatDate(day.date, "d בMMMM yyyy");
  const heading = `יום ${day.dayNumber}${weekday ? ` – ${weekday}` : ""}${dateLabel ? ` | ${dateLabel}` : ""}${day.title ? `: ${bidiName(day.title)}` : ""}`;

  const subLine = [day.cityRegion ? bidiName(day.cityRegion) : "", day.accommodation ? `לינה: ${bidiName(day.accommodation)}` : ""]
    .filter(Boolean)
    .join(" · ");

  const items = sortedItems(day.items).map(renderItem).join("");

  const dayNotes = [
    day.notes ? `<p class="notes">${escapeHtml(day.notes)}</p>` : "",
    ...day.warnings.map((warning) => `<p class="warning">⚠ ${escapeHtml(warning)}</p>`),
  ].join("");

  return `
    <section class="day">
      <div class="day-heading">
        <h2>${heading}</h2>
        ${subLine ? `<p class="sub">${subLine}</p>` : ""}
      </div>
      ${dayNotes}
      ${items ? `<ol>${items}</ol>` : '<p class="empty">אין פעילויות מתוכננות ליום זה.</p>'}
      ${dayCostBreakdown(day)}
      ${geoDebugContext ? renderGeographyDebugSection(day, geoDebugContext) : ""}
    </section>`;
}

function renderSummaryBullets(days: TripItineraryDay[]): string {
  const lines = days
    .map((day) => {
      const dateLabel = formatDate(day.date, "d.M");
      const headline = day.title || day.cityRegion || "";
      return `<li>${dateLabel ? `<bdi dir="ltr">${escapeHtml(dateLabel)}</bdi> · ` : ""}<strong>יום ${day.dayNumber}</strong>${headline ? `: ${bidiName(headline)}` : ""}</li>`;
    })
    .join("");
  return `
    <section class="summary-section">
      <h2>סיכום בנקודות</h2>
      <ul class="summary-list">${lines}</ul>
    </section>`;
}

function flightLegLine(label: string, leg: TripFlightLeg | null): string {
  if (!leg || !leg.departureAirport || !leg.arrivalAirport) return "";
  const dateLabel = formatDate(leg.departureDate, "d.M.yyyy");
  const details = [
    `<bdi dir="ltr">${escapeHtml(leg.departureAirport)} → ${escapeHtml(leg.arrivalAirport)}</bdi>`,
    dateLabel,
    leg.departureTime ? `המראה ${escapeHtml(leg.departureTime)}` : "",
    leg.arrivalTime ? `נחיתה ${escapeHtml(leg.arrivalTime)}${leg.estimated ? " (משוער)" : ""}` : "",
    leg.airline || leg.flightNumber ? bidiName(`${leg.airline} ${leg.flightNumber}`.trim()) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<li><strong>${escapeHtml(label)}:</strong> ${details}</li>`;
}

function renderPracticalInfo(days: TripItineraryDay[], workspace?: CountryTripWorkspaceState): string {
  const flights = workspace?.preferences.flights;
  const flightLines = flights
    ? [flightLegLine("טיסת הלוך", flights.outbound), flightLegLine("טיסת חזור", flights.return)].filter(Boolean).join("")
    : "";

  const bookingRequirements = [...new Set(days.flatMap((day) => day.bookingRequirements).filter(Boolean))];
  const safetyNotes = [...new Set(days.flatMap((day) => day.safetyNotes).filter(Boolean))];

  if (!flightLines && bookingRequirements.length === 0 && safetyNotes.length === 0) return "";

  return `
    <section class="practical-section">
      <h2>מידע מעשי</h2>
      ${flightLines ? `<ul class="plain-list">${flightLines}</ul>` : ""}
      ${
        bookingRequirements.length > 0
          ? `<h3>דברים להזמין מראש</h3><ul class="check-list">${bookingRequirements
              .map((requirement) => `<li>☐ ${escapeHtml(requirement)}</li>`)
              .join("")}</ul>`
          : ""
      }
      ${
        safetyNotes.length > 0
          ? `<h3>שימו לב</h3><ul class="check-list">${safetyNotes
              .map((note) => `<li>⚠ ${escapeHtml(note)}</li>`)
              .join("")}</ul>`
          : ""
      }
    </section>`;
}

export function buildItineraryPdfHtml(
  itinerary: CountryItineraryRecord,
  countryName: string,
  workspace?: CountryTripWorkspaceState,
  debugGeoEnabled = false,
  geoResolutionOverride: GeoResolutionOverrideMap | null = null
): string {
  const title = itineraryDisplayTitle(itinerary, countryName);
  const dates = formatTripDateRangeExpanded(
    itinerary.startDate,
    itinerary.endDate,
    itinerary.preferencesSnapshot.partialDate
  );
  const days = [...itinerary.itineraryDays].sort((first, second) => first.dayNumber - second.dayNumber);
  // Spec "אני רואה את זה בשנייה במקום להסיק לאורך 44 ימים" — one line for
  // the whole trip, shown once near the top, not repeated per day.
  const geoResolutionSummary = debugGeoEnabled ? computeGeoResolutionMatchSummary(days, geoResolutionOverride) : null;
  const dayHtml = days
    .map((day, index) =>
      renderDay(
        day,
        debugGeoEnabled
          ? {
              previousDay: index > 0 ? days[index - 1] : null,
              isFirstDay: index === 0,
              isLastDay: index === days.length - 1,
              geoResolutionOverride,
            }
          : undefined
      )
    )
    .join("");

  return `<!doctype html>
    <html lang="he" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          @page { size: A4; margin: 18mm; }
          body { color: #2d251d; font-family: Arial, sans-serif; line-height: 1.5; }
          h1, h2, h3, p, ul, ol { margin: 0; }
          header { border-bottom: 3px solid #c96a2c; margin-bottom: 22px; padding-bottom: 14px; }
          h1 { font-size: 26px; }
          .dates, .summary { color: #756354; margin-top: 5px; }
          .facts { display: grid; gap: 8px; grid-template-columns: repeat(3, 1fr); margin-top: 16px; }
          .fact { background: #fff8ed; border: 1px solid #ead4b2; border-radius: 8px; padding: 8px; }
          .fact span { color: #756354; display: block; font-size: 12px; }
          .summary-section { break-inside: avoid; background: #fff8ed; border: 1px solid #ead4b2; border-radius: 10px; margin-bottom: 20px; padding: 14px 16px; }
          .summary-section h2 { color: #c96a2c; font-size: 15px; margin-bottom: 8px; }
          .summary-list { list-style: none; padding: 0; }
          .summary-list li { border-bottom: 1px dashed #ead4b2; font-size: 13px; padding: 4px 0; }
          .summary-list li:last-child { border-bottom: none; }
          .day { break-inside: avoid; border-bottom: 1px solid #ead4b2; padding: 16px 0; }
          .day-heading h2 { color: #c96a2c; font-size: 18px; }
          .day-heading .sub, li .location, li .meta, .empty { color: #756354; font-size: 13px; }
          .notes { margin-top: 8px; }
          ol { list-style: none; margin: 12px 0 0; padding: 0; }
          li { border-right: 3px solid #ead4b2; margin-bottom: 10px; padding-right: 10px; }
          .item-head { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; }
          li strong, li .location { display: block; }
          li p { font-size: 13px; margin-top: 2px; }
          li .price { background: #fff0dc; border-radius: 5px; color: #a85a1e; font-size: 12px; font-weight: 600; padding: 1px 7px; white-space: nowrap; }
          .warning { color: #a1451c; }
          .day-cost { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
          .cost-total { font-size: 13px; font-weight: 600; }
          .cost-badge { background: #f4ede1; border-radius: 12px; color: #756354; font-size: 11px; padding: 2px 9px; }
          .practical-section { break-inside: avoid; margin-top: 22px; }
          .practical-section h2 { color: #c96a2c; font-size: 16px; margin-bottom: 6px; }
          .practical-section h3 { font-size: 13px; margin-top: 12px; }
          .plain-list, .check-list { list-style: none; margin-top: 6px; padding: 0; }
          .plain-list li, .check-list li { font-size: 13px; padding: 3px 0; }
          .geo-debug { background: #fffbe6; border: 1px dashed #d4a017; border-radius: 6px; font-family: monospace; font-size: 11px; margin-top: 10px; padding: 8px 10px; }
          .geo-debug-title { color: #8a6d00; font-family: Arial, sans-serif; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
          .geo-debug-mismatch { color: #b3261e; }
          .geo-debug-table { border-collapse: collapse; margin-top: 6px; width: 100%; }
          .geo-debug-table th, .geo-debug-table td { border: 1px solid #e6d28f; padding: 2px 6px; text-align: right; }
          .geo-debug-unresolved { color: #b3261e; }
          .geo-debug-unmatched { color: #b06a00; font-weight: 700; }
          .geo-debug-summary { background: #fffbe6; border: 1px dashed #d4a017; border-radius: 6px; font-family: monospace; font-size: 12px; margin: 12px 0; padding: 6px 10px; }
          @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
        </style>
      </head>
      <body>
        <header>
          <h1>${escapeHtml(title)}</h1>
          <p class="dates">${escapeHtml(dates)}</p>
          ${itinerary.summary ? `<p class="summary">${escapeHtml(itinerary.summary)}</p>` : ""}
          <div class="facts">
            <div class="fact"><span>משך הטיול</span>${itinerary.daysCount} ימים</div>
            <div class="fact"><span>נוסעים</span>${itinerary.travelers}</div>
            <div class="fact"><span>עלות כוללת משוערת</span>${escapeHtml(formatCurrency(itinerary.costSummary.totalEstimatedCost))}</div>
          </div>
        </header>
        ${
          geoResolutionSummary
            ? `<div class="geo-debug-summary">🔧 geo-resolution: ${geoResolutionSummary.matched}/${geoResolutionSummary.total} items matched</div>`
            : ""
        }
        ${days.length > 0 ? renderSummaryBullets(days) : ""}
        ${dayHtml || '<p class="empty">אין ימים מתוכננים במסלול זה.</p>'}
        ${renderPracticalInfo(days, workspace)}
        <script>window.addEventListener("load", () => window.print());</script>
      </body>
    </html>`;
}

/**
 * Opens a new tab with the printable itinerary and triggers the browser's
 * print dialog (the user picks "Save as PDF"). Returns false (and lets the
 * caller show its own toast) when the popup was blocked.
 *
 * `geoResolutionOverride` is the caller's responsibility (via
 * useGeoResolutionDebugMap, already fetched by the time the export button
 * is clicked) rather than fetched here — keeps this function synchronous,
 * so window.open()'s popup-blocker-sensitive timing is untouched.
 */
export function openItineraryPdfExport(
  itinerary: CountryItineraryRecord,
  countryName: string,
  workspace?: CountryTripWorkspaceState,
  geoResolutionOverride: GeoResolutionOverrideMap | null = null
): boolean {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return false;
  printWindow.opener = null;
  // Reads the CURRENT page's own ?debugGeo=1 (the same flag the itinerary
  // day screen checks) rather than adding a third way to opt in — a user
  // who's already looking at the debug overlay on-screen gets it in the
  // exported PDF too, with no extra step.
  const debugGeoEnabled = new URLSearchParams(window.location.search).get("debugGeo") === "1";
  printWindow.document.write(
    buildItineraryPdfHtml(itinerary, countryName, workspace, debugGeoEnabled, geoResolutionOverride)
  );
  printWindow.document.close();
  return true;
}
