import { NextResponse } from "next/server";

import { getTripDocumentSignedUrl } from "@/lib/server/trip-documents-storage";
import { createAdminClient } from "@/lib/supabase/admin";

// The explicit "open document" action -- mints a short-lived signed URL on
// demand. Never called automatically; the client only hits this when the
// user clicks "פתח מסמך", so a sensitive document's contents are never
// fetched/rendered just by loading the Travel Wallet list.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string; documentId: string }> }
) {
  const { itineraryId, documentId } = await params;
  const supabase = createAdminClient();

  try {
    const url = await getTripDocumentSignedUrl(supabase, itineraryId, documentId);
    return NextResponse.json({ url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create signed URL" },
      { status: 500 }
    );
  }
}
