import { NextResponse } from "next/server";

import { loadEffectiveCountryStatuses } from "@/lib/server/country-statuses";
import { createAdminClient } from "@/lib/supabase/admin";

// getDestinationDateString is timezone-per-country and evaluated at
// request time — a country whose trip starts "today" in another timezone
// must not be served a stale "planned". Never statically cached.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createAdminClient();
  try {
    const countries = await loadEffectiveCountryStatuses(supabase);
    return NextResponse.json({ countries });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load country statuses" },
      { status: 500 }
    );
  }
}
