"use client";

import { useMemo, useState } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
} from "@/components/ui/combobox";
import {
  COUNTRY_NAMES_HE,
  countryFlagEmoji,
  findAirportByIata,
  searchAirports,
  type AirportInfo,
} from "@/lib/facts/airports-data";

/**
 * Searchable by city, airport name, or IATA code — never a plain free-text
 * field when airport data exists (spec item 1/9). `pool` restricts both the
 * empty-query list AND the search itself to a specific, already-filtered
 * set of candidate airports (e.g. getIsraeliAirports(),
 * findAirportsForCountry(iso), getConnectionAirports(exclude)) — a
 * country-restricted field must never fall through to the global airport
 * list just because a search term happens to match something outside it.
 * Omit `pool` for an unrestricted field (used only for connections).
 */
export function AirportCombobox({
  value,
  onChange,
  placeholder,
  pool,
}: {
  value: string;
  onChange: (iata: string) => void;
  placeholder?: string;
  pool?: AirportInfo[];
}) {
  const [query, setQuery] = useState("");
  const selectedAirport = value ? findAirportByIata(value) : null;
  const results = useMemo(() => searchAirports(query, { pool }), [query, pool]);

  return (
    <Combobox<AirportInfo>
      items={results}
      value={selectedAirport}
      isItemEqualToValue={(a, b) => a.iata === b.iata}
      itemToStringLabel={(airport) => `${countryFlagEmoji(airport.countryIso)} ${airport.iata} · ${airport.name}`}
      onValueChange={(airport) => onChange(airport?.iata ?? "")}
      onInputValueChange={setQuery}
      filter={null}
    >
      <ComboboxInput placeholder={placeholder ?? "חיפוש נמל תעופה..."} />
      <ComboboxContent>
        <ComboboxEmpty>לא נמצאו שדות תעופה תואמים</ComboboxEmpty>
        {results.map((airport) => (
          <ComboboxItem key={airport.iata} value={airport}>
            <span className="flex flex-col py-0.5">
              <span className="flex items-center gap-1.5">
                <span aria-hidden>{countryFlagEmoji(airport.countryIso)}</span>
                <span className="font-medium">{airport.iata}</span>
                <span className="text-muted-foreground">— {airport.name}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {airport.city}, {COUNTRY_NAMES_HE[airport.countryIso] ?? airport.countryIso}
              </span>
            </span>
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}
