import { CountryPageClient } from "@/components/country/country-page-client";

export const dynamic = "force-dynamic";

export default async function CountryPage({ params }: { params: Promise<{ iso: string }> }) {
  const { iso } = await params;
  return (
    <main className="flex min-h-screen w-full flex-col">
      <CountryPageClient iso={iso} />
    </main>
  );
}
