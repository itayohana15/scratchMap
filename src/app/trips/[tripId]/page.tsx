import { TripPageClient } from "@/components/trips/trip-page-client";

export const dynamic = "force-dynamic";

export default async function TripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  return <TripPageClient tripId={tripId} />;
}
