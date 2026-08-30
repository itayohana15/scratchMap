"use client";

import { useMemo, useState } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
} from "@/components/ui/combobox";
import { countryFlagEmoji, getAvailableConnectionCountries } from "@/lib/facts/airports-data";

type CountryOption = { iso: string; nameHe: string };

/**
 * Searchable combobox over every country this app has airport data for
 * (spec item 4 — "+ הוסף קונקשן" must first ask for the connection's own
 * country before revealing an airport field). Mirrors AirportCombobox's
 * primitives and flag+name convention for visual/interaction consistency.
 */
export function CountryIsoCombobox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const countries = useMemo(() => getAvailableConnectionCountries(), []);
  const selected = value ? countries.find((country) => country.iso === value.toUpperCase()) ?? null : null;
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return countries;
    return countries.filter(
      (country) => country.nameHe.toLowerCase().includes(normalized) || country.iso.toLowerCase().includes(normalized)
    );
  }, [countries, query]);

  return (
    <Combobox<CountryOption>
      items={results}
      value={selected}
      isItemEqualToValue={(a, b) => a.iso === b.iso}
      itemToStringLabel={(country) => `${countryFlagEmoji(country.iso)} ${country.nameHe}`}
      onValueChange={(country) => onChange(country?.iso ?? "")}
      onInputValueChange={setQuery}
      filter={null}
    >
      <ComboboxInput placeholder={placeholder ?? "חיפוש מדינה..."} />
      <ComboboxContent>
        <ComboboxEmpty>לא נמצאו מדינות תואמות</ComboboxEmpty>
        {results.map((country) => (
          <ComboboxItem key={country.iso} value={country}>
            <span className="flex items-center gap-1.5 py-0.5">
              <span aria-hidden>{countryFlagEmoji(country.iso)}</span>
              <span className="font-medium">{country.nameHe}</span>
            </span>
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}
