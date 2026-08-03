import { CityPageClient } from "@/components/city/city-page-client";

export const dynamic = "force-dynamic";

export default async function CityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <CityPageClient id={id} />
    </main>
  );
}
