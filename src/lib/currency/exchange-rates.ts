"use client";

import { useQuery } from "@tanstack/react-query";

export interface ExchangeRates {
  base: string;
  rates: Record<string, number>;
  updatedAt: string;
}

interface OpenErApiResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_utc: string;
}

async function fetchExchangeRates(base: string): Promise<ExchangeRates> {
  const res = await fetch(`https://open.er-api.com/v6/latest/${base.toUpperCase()}`);
  if (!res.ok) throw new Error("Failed to load exchange rates");
  const data = (await res.json()) as OpenErApiResponse;
  if (data.result !== "success") throw new Error("Failed to load exchange rates");

  return {
    base: data.base_code,
    rates: data.rates,
    updatedAt: data.time_last_update_utc,
  };
}

export function useExchangeRates(base: string) {
  return useQuery({
    queryKey: ["exchange-rates", base.toUpperCase()],
    queryFn: () => fetchExchangeRates(base),
    staleTime: 1000 * 60 * 60,
    retry: false,
  });
}

export const COMMON_CURRENCIES: { code: string; label: string }[] = [
  { code: "ILS", label: "שקל ישראלי (₪)" },
  { code: "USD", label: "דולר אמריקאי ($)" },
  { code: "EUR", label: "יורו (€)" },
  { code: "GBP", label: "לירה שטרלינג (£)" },
  { code: "JPY", label: "ין יפני (¥)" },
  { code: "CHF", label: "פרנק שוויצרי (CHF)" },
  { code: "CAD", label: "דולר קנדי (CA$)" },
  { code: "AUD", label: "דולר אוסטרלי (A$)" },
];
