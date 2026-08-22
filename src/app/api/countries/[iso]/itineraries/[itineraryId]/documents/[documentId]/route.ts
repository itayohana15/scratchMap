import { NextResponse } from "next/server";

import { deleteTripDocument } from "@/lib/server/trip-documents-storage";
import { createAdminClient } from "@/lib/supabase/admin";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string; documentId: string }> }
) {
  const { itineraryId, documentId } = await params;
  const supabase = createAdminClient();

  try {
    await deleteTripDocument(supabase, itineraryId, documentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete document" },
      { status: 500 }
    );
  }
}
