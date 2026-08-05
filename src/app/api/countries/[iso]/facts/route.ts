import { NextResponse } from "next/server";

import countryFactsData from "@/lib/facts/country-facts-data.json";

interface RawCountryFacts {
  name: string;
  capital: string[];
  region: string;
  subregion: string | null;
  area: number | null;
  population: number | null;
  currencies: { code: string; name: string; symbol: string }[];
  languages: string[];
}

const CONTINENT_LABELS_HE: Record<string, string> = {
  Africa: "אפריקה",
  Americas: "אמריקה",
  Asia: "אסיה",
  Europe: "אירופה",
  Oceania: "אוקיאניה",
  Antarctic: "אנטארקטיקה",
};

export async function GET(_request: Request, { params }: { params: Promise<{ iso: string }> }) {
  const { iso } = await params;
  const raw = (countryFactsData as Record<string, RawCountryFacts>)[iso.toUpperCase()];

  if (!raw) {
    return NextResponse.json({ error: `No facts available for: ${iso}` }, { status: 404 });
  }

  return NextResponse.json({
    englishName: raw.name,
    capital: raw.capital[0] ?? null,
    population: raw.population,
    area: raw.area,
    continent: CONTINENT_LABELS_HE[raw.region] ?? raw.region,
    currency: raw.currencies[0] ? `${raw.currencies[0].name} (${raw.currencies[0].symbol})` : null,
    currencyCode: raw.currencies[0]?.code ?? null,
    currencySymbol: raw.currencies[0]?.symbol ?? null,
    languages: raw.languages,
  });
}
