"use client";

import { useMutation } from "@tanstack/react-query";

import type { TripDocumentType } from "@/lib/trip-workspace";

export interface UploadedTripDocument {
  id: string;
  tripId: string;
  bookingId: string | null;
  itineraryItemId: string | null;
  type: TripDocumentType;
  title: string;
  fileName: string;
  mimeType: string;
  notes: string;
  isSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Request failed");
  }
  return (await response.json()) as T;
}

interface UploadTripDocumentInput {
  iso: string;
  itineraryId: string;
  file: File;
  type: TripDocumentType;
  title: string;
  notes: string;
  isSensitive: boolean;
  bookingId?: string | null;
  itineraryItemId?: string | null;
}

export function useUploadTripDocument() {
  return useMutation({
    mutationFn: async (input: UploadTripDocumentInput) => {
      const formData = new FormData();
      formData.set("file", input.file);
      formData.set("type", input.type);
      formData.set("title", input.title);
      formData.set("notes", input.notes);
      formData.set("isSensitive", String(input.isSensitive));
      if (input.bookingId) formData.set("bookingId", input.bookingId);
      if (input.itineraryItemId) formData.set("itineraryItemId", input.itineraryItemId);

      const data = await parseJson<{ document: UploadedTripDocument }>(
        await fetch(
          `/api/countries/${input.iso.toLowerCase()}/itineraries/${input.itineraryId}/documents`,
          { method: "POST", body: formData }
        )
      );
      return data.document;
    },
  });
}

export function useDeleteTripDocument() {
  return useMutation({
    mutationFn: async ({ iso, itineraryId, documentId }: { iso: string; itineraryId: string; documentId: string }) => {
      await parseJson<{ ok: true }>(
        await fetch(
          `/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/documents/${documentId}`,
          { method: "DELETE" }
        )
      );
      return documentId;
    },
  });
}

export function useOpenTripDocument() {
  return useMutation({
    mutationFn: async ({ iso, itineraryId, documentId }: { iso: string; itineraryId: string; documentId: string }) => {
      const data = await parseJson<{ url: string }>(
        await fetch(
          `/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/documents/${documentId}/signed-url`
        )
      );
      return data.url;
    },
  });
}
