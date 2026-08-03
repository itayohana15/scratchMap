import { CountryPageClient } from "@/components/country/country-page-client";

export const dynamic = "force-dynamic";

export default async function CountryPage({ params }: { params: Promise<{ iso: string }> }) {
  const { iso } = await params;
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <CountryPageClient iso={iso} />
    </main>
  );
}
