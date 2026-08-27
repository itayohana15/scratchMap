import type {
  CountryTripWorkspaceState,
  RecommendationCategory,
  TripFlightLeg,
  TripItineraryDay,
  TripItineraryItem,
} from "@/lib/trip-workspace";
import { buildSuggestedItineraryTitle, type CountryItineraryRecord } from "@/lib/itineraries";
import { formatCurrency, formatDate, formatTripDateRange, formatTripDateRangeExpanded } from "@/lib/format";

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

function renderItem(item: TripItineraryItem): string {
  const emoji = CATEGORY_EMOJI[item.category] ?? "•";
  const price = item.approximatePrice && item.approximatePrice > 0 ? formatCurrency(item.approximatePrice) : "";
  return `
    <li>
      <div class="item-head">
        <strong>${item.plannedStartTime ? `${escapeHtml(item.plannedStartTime)} · ` : ""}${emoji} ${escapeHtml(item.name)}</strong>
        ${price ? `<span class="price">${escapeHtml(price)}</span>` : ""}
      </div>
      ${item.location ? `<span class="location">${escapeHtml(item.location)}</span>` : ""}
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

function renderDay(day: TripItineraryDay): string {
  const weekday = formatDate(day.date, "EEEE");
  const dateLabel = formatDate(day.date, "d בMMMM yyyy");
  const heading = `יום ${day.dayNumber}${weekday ? ` – ${weekday}` : ""}${dateLabel ? ` | ${dateLabel}` : ""}${day.title ? `: ${escapeHtml(day.title)}` : ""}`;

  const subLine = [day.cityRegion, day.accommodation ? `לינה: ${day.accommodation}` : ""]
    .filter(Boolean)
    .map(escapeHtml)
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
    </section>`;
}

function renderSummaryBullets(days: TripItineraryDay[]): string {
  const lines = days
    .map((day) => {
      const dateLabel = formatDate(day.date, "d.M");
      const headline = day.title || day.cityRegion || "";
      return `<li>${dateLabel ? `<bdi dir="ltr">${escapeHtml(dateLabel)}</bdi> · ` : ""}<strong>יום ${day.dayNumber}</strong>${headline ? `: ${escapeHtml(headline)}` : ""}</li>`;
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
    leg.airline || leg.flightNumber ? `${escapeHtml(leg.airline)} ${escapeHtml(leg.flightNumber)}`.trim() : "",
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

function buildItineraryPdfHtml(
  itinerary: CountryItineraryRecord,
  countryName: string,
  workspace?: CountryTripWorkspaceState
): string {
  const title = itineraryDisplayTitle(itinerary, countryName);
  const dates = formatTripDateRangeExpanded(
    itinerary.startDate,
    itinerary.endDate,
    itinerary.preferencesSnapshot.partialDate
  );
  const days = [...itinerary.itineraryDays].sort((first, second) => first.dayNumber - second.dayNumber);
  const dayHtml = days.map(renderDay).join("");

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
 */
export function openItineraryPdfExport(
  itinerary: CountryItineraryRecord,
  countryName: string,
  workspace?: CountryTripWorkspaceState
): boolean {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return false;
  printWindow.opener = null;
  printWindow.document.write(buildItineraryPdfHtml(itinerary, countryName, workspace));
  printWindow.document.close();
  return true;
}
