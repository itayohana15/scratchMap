import type { CountryItineraryRecord } from "@/lib/itineraries";
import type { TripDocument } from "@/lib/trip-workspace";

type PatchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;

export function documents(itinerary: CountryItineraryRecord | null): TripDocument[] {
  return itinerary?.workspaceSnapshot?.documents ?? [];
}

// The file itself is uploaded via the /documents API route (server-mediated,
// private bucket) before this is ever called — this only appends the
// resulting metadata row into the workspace JSONB blob.
export function appendDocument(patchDraft: PatchDraft, document: TripDocument) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      documents: [...documents(current).filter((item) => item.id !== document.id), document],
    },
  }));
}

export function patchDocumentLocal(patchDraft: PatchDraft, documentId: string, patch: Partial<TripDocument>) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      documents: documents(current).map((item) =>
        item.id === documentId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item
      ),
    },
  }));
}

// Removes the local metadata reference only — the caller is responsible for
// calling the DELETE API route first so the storage object + DB row are
// actually removed.
export function removeDocumentLocal(patchDraft: PatchDraft, documentId: string) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      documents: documents(current).filter((item) => item.id !== documentId),
    },
  }));
}
