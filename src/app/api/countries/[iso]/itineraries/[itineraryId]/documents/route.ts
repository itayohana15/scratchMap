import { NextResponse } from "next/server";

import { listTripDocuments, uploadTripDocument } from "@/lib/server/trip-documents-storage";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { itineraryId } = await params;
  const supabase = createAdminClient();

  try {
    const documents = await listTripDocuments(supabase, itineraryId);
    return NextResponse.json({ documents });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load documents" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { itineraryId } = await params;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const type = String(formData.get("type") ?? "other");
  const title = String(formData.get("title") ?? file.name);
  const notes = String(formData.get("notes") ?? "");
  const isSensitive = formData.get("isSensitive") === "true";
  const bookingId = formData.get("bookingId");
  const itineraryItemId = formData.get("itineraryItemId");

  const supabase = createAdminClient();

  try {
    const document = await uploadTripDocument(supabase, itineraryId, {
      file,
      type,
      title,
      notes,
      isSensitive,
      bookingId: typeof bookingId === "string" && bookingId ? bookingId : null,
      itineraryItemId: typeof itineraryItemId === "string" && itineraryItemId ? itineraryItemId : null,
    });
    return NextResponse.json({ document });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload document" },
      { status: 500 }
    );
  }
}
