import { CountryPageClient } from "@/components/country/country-page-client";

export const dynamic = "force-dynamic";

export default async function CountryPage({
  params,
  searchParams,
}: {
  params: Promise<{ iso: string }>;
  searchParams: Promise<{ itinerary?: string | string[] }>;
}) {
  const { iso } = await params;
  const resolvedSearchParams = await searchParams;
  const itinerary =
    typeof resolvedSearchParams.itinerary === "string" ? resolvedSearchParams.itinerary : null;
  return (
    <main className="flex min-h-screen w-full flex-col">
      <CountryPageClient iso={iso} initialItineraryId={itinerary} />
    </main>
  );
}
