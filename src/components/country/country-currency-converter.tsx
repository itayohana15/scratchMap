"use client";

import { ArrowLeftRight, Clock } from "lucide-react";
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useCountryFacts } from "@/lib/facts/country-facts";
import { COMMON_CURRENCIES, useExchangeRates } from "@/lib/currency/exchange-rates";

const QUICK_AMOUNTS = [10, 50, 100, 500, 1000];

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("he-IL", { maximumFractionDigits }).format(value);
}

interface CountryCurrencyConverterProps {
  isoA2: string;
  countryName: string;
}

export function CountryCurrencyConverter({ isoA2, countryName }: CountryCurrencyConverterProps) {
  const { data: facts, isLoading: factsLoading } = useCountryFacts(isoA2);
  const [homeCurrency, setHomeCurrency] = useState("ILS");
  const [amount, setAmount] = useState("100");

  const { data: rates, isLoading: ratesLoading, isError } = useExchangeRates(homeCurrency);

  const targetCode = facts?.currencyCode ?? null;
  const targetLabel = facts?.currency ?? null;

  const rate = targetCode && rates ? rates.rates[targetCode] : undefined;
  const numericAmount = Number(amount) || 0;

  const converted = rate != null ? numericAmount * rate : null;
  const inverseRate = rate != null && rate !== 0 ? 1 / rate : null;

  const quickConversions = useMemo(() => {
    if (rate == null) return [];
    return QUICK_AMOUNTS.map((value) => ({ value, converted: value * rate }));
  }, [rate]);

  if (factsLoading) {
    return <Skeleton className="h-64 rounded-[20px]" />;
  }

  if (!targetCode) {
    return (
      <div className="section-card p-6 text-sm text-muted-foreground">
        אין לנו נתוני מטבע זמינים עבור {countryName} כרגע.
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_380px]">
      <div className="section-card space-y-5 p-6 sm:p-8">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-5 text-primary" />
          <h3 className="text-lg font-semibold">המרת מטבע ל{countryName}</h3>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">סכום</label>
            <Input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="100"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">המטבע שלי</label>
            <Select value={homeCurrency} onValueChange={(value) => value && setHomeCurrency(value)}>
              <SelectTrigger size="sm" className="w-full">
                <span>{COMMON_CURRENCIES.find((c) => c.code === homeCurrency)?.label ?? homeCurrency}</span>
              </SelectTrigger>
              <SelectContent>
                {COMMON_CURRENCIES.map((currency) => (
                  <SelectItem key={currency.code} value={currency.code}>
                    {currency.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-center text-muted-foreground sm:pb-2.5">
            <ArrowLeftRight className="size-4 rotate-90 sm:rotate-0" />
          </div>
        </div>

        {ratesLoading ? (
          <Skeleton className="h-24 rounded-2xl" />
        ) : isError || converted == null ? (
          <div className="rounded-2xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
            לא הצלחנו לטעון שערי חליפין עדכניים כרגע. נסו שוב מאוחר יותר.
          </div>
        ) : (
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5 text-center">
            <p className="text-sm text-muted-foreground">
              {formatNumber(numericAmount)} {homeCurrency} שווים בהערכה ל
            </p>
            <p className="mt-1 text-4xl font-bold tracking-tight text-primary">
              {formatNumber(converted)} {targetCode}
            </p>
            {targetLabel && <p className="mt-1 text-xs text-muted-foreground">{targetLabel}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground">
              שער הערכה בלבד — עשוי להיות שונה מהשער בפועל בבנק או בחברת האשראי.
            </p>
          </div>
        )}

        {rate != null && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            <span>
              1 {homeCurrency} = {formatNumber(rate, 4)} {targetCode} · 1 {targetCode} ={" "}
              {inverseRate != null ? formatNumber(inverseRate, 4) : "—"} {homeCurrency}
            </span>
            {rates?.updatedAt && <span>· עודכן: {new Date(rates.updatedAt).toLocaleDateString("he-IL")}</span>}
          </div>
        )}
      </div>

      <div className="section-card space-y-3 p-6 sm:p-8">
        <h3 className="text-lg font-semibold">טבלה מהירה</h3>
        {quickConversions.length > 0 ? (
          <ul className="divide-y divide-border/60">
            {quickConversions.map((row) => (
              <li key={row.value} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="font-medium">
                  {formatNumber(row.value)} {homeCurrency}
                </span>
                <span className="text-muted-foreground">
                  {formatNumber(row.converted)} {targetCode}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">הטבלה תופיע לאחר טעינת שערי החליפין.</p>
        )}
      </div>
    </div>
  );
}
