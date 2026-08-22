import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/types";

type DbClient = SupabaseClient<Database>;

const BUCKET = "trip-documents";
// No file-size/type guardrails exist anywhere in the app today (confirmed
// during investigation) -- these are new, reasonable defaults for travel
// documents (scans/PDFs), not a pre-existing limit being tightened.
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const SIGNED_URL_EXPIRES_IN_SECONDS = 300;

export interface TripDocumentRecord {
  id: string;
  tripId: string;
  bookingId: string | null;
  itineraryItemId: string | null;
  type: string;
  title: string;
  fileName: string;
  mimeType: string;
  notes: string;
  isSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

function normalizeDocumentRow(row: Tables<"trip_documents">): TripDocumentRecord {
  return {
    id: row.id,
    tripId: row.itinerary_id,
    bookingId: row.booking_id,
    itineraryItemId: row.itinerary_item_id,
    type: row.type,
    title: row.title,
    fileName: row.file_name,
    mimeType: row.mime_type,
    notes: row.notes,
    isSensitive: row.is_sensitive,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTripDocuments(supabase: DbClient, itineraryId: string): Promise<TripDocumentRecord[]> {
  const { data, error } = await supabase
    .from("trip_documents")
    .select("*")
    .eq("itinerary_id", itineraryId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(normalizeDocumentRow);
}

export async function uploadTripDocument(
  supabase: DbClient,
  itineraryId: string,
  args: {
    file: File;
    type: string;
    title: string;
    notes: string;
    isSensitive: boolean;
    bookingId: string | null;
    itineraryItemId: string | null;
  }
): Promise<TripDocumentRecord> {
  if (args.file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error("הקובץ גדול מדי (מקסימום 15MB).");
  }
  if (!ALLOWED_MIME_TYPES.has(args.file.type)) {
    throw new Error("סוג הקובץ אינו נתמך. יש להעלות PDF או תמונה.");
  }

  const extension = args.file.name.split(".").pop() ?? "bin";
  const storagePath = `${itineraryId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, args.file, { contentType: args.file.type, upsert: false });
  if (uploadError) throw new Error(uploadError.message);

  const { data, error } = await supabase
    .from("trip_documents")
    .insert({
      itinerary_id: itineraryId,
      booking_id: args.bookingId,
      itinerary_item_id: args.itineraryItemId,
      type: args.type,
      title: args.title,
      storage_path: storagePath,
      file_name: args.file.name,
      mime_type: args.file.type,
      notes: args.notes,
      is_sensitive: args.isSensitive,
    })
    .select("*")
    .single();

  if (error) {
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw new Error(error.message);
  }

  return normalizeDocumentRow(data);
}

async function fetchOwnedDocumentRow(supabase: DbClient, itineraryId: string, documentId: string) {
  const { data, error } = await supabase
    .from("trip_documents")
    .select("*")
    .eq("id", documentId)
    .eq("itinerary_id", itineraryId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Document not found");
  return data;
}

export async function deleteTripDocument(supabase: DbClient, itineraryId: string, documentId: string): Promise<void> {
  const row = await fetchOwnedDocumentRow(supabase, itineraryId, documentId);

  const { error: storageError } = await supabase.storage.from(BUCKET).remove([row.storage_path]);
  if (storageError) throw new Error(storageError.message);

  const { error } = await supabase.from("trip_documents").delete().eq("id", documentId);
  if (error) throw new Error(error.message);
}

// The one and only way to read a document's bytes -- a short-lived signed
// URL, minted only on this explicit call (never rendered/pre-fetched by
// default), matching the "sensitive documents require an explicit open
// action" requirement.
export async function getTripDocumentSignedUrl(
  supabase: DbClient,
  itineraryId: string,
  documentId: string
): Promise<string> {
  const row = await fetchOwnedDocumentRow(supabase, itineraryId, documentId);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_EXPIRES_IN_SECONDS);
  if (error || !data) throw new Error(error?.message ?? "Failed to create signed URL");

  return data.signedUrl;
}
