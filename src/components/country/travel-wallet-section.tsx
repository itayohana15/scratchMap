"use client";

import { FileText, Lock, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { useDeleteTripDocument, useOpenTripDocument, useUploadTripDocument } from "@/lib/queries/trip-documents";
import { documents, removeDocumentLocal } from "@/lib/trip-documents";
import { TRIP_DOCUMENT_TYPE_LABELS, type TripDocument, type TripDocumentType } from "@/lib/trip-workspace";

interface TravelWalletSectionProps {
  draft: CountryItineraryRecord;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  isoA2: string;
  onDocumentUploaded: (document: TripDocument) => void;
}

function DocumentCard({
  document,
  onOpen,
  onDelete,
  isOpening,
  isDeleting,
}: {
  document: TripDocument;
  onOpen: () => void;
  onDelete: () => void;
  isOpening: boolean;
  isDeleting: boolean;
}) {
  return (
    <div className="section-card flex items-start justify-between gap-3 p-4">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {document.isSensitive ? (
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="mt-0.5 size-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <h4 className="font-medium text-foreground">{document.title || document.fileName}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{TRIP_DOCUMENT_TYPE_LABELS[document.type]}</p>
          {document.notes ? <p className="mt-1 text-xs text-muted-foreground">{document.notes}</p> : null}
          {document.isSensitive ? (
            <Badge variant="outline" className="mt-2 gap-1">
              <Lock className="size-3" />
              מסמך רגיש
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={onOpen} disabled={isOpening}>
          {isOpening ? <LoaderCircle className="size-4 animate-spin" /> : null}
          פתח מסמך
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="מחיקת מסמך" onClick={onDelete} disabled={isDeleting}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function TravelWalletSection({ draft, onPatchDraft, isoA2, onDocumentUploaded }: TravelWalletSectionProps) {
  const documentList = documents(draft);
  const uploadDocument = useUploadTripDocument();
  const deleteDocument = useDeleteTripDocument();
  const openDocument = useOpenTripDocument();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<TripDocumentType>("other");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [isSensitive, setIsSensitive] = useState(false);

  function resetForm() {
    setFile(null);
    setTitle("");
    setNotes("");
    setType("other");
    setIsSensitive(false);
    setFormOpen(false);
  }

  async function handleUpload() {
    if (!file) return;
    try {
      const document = await uploadDocument.mutateAsync({
        iso: isoA2,
        itineraryId: draft.id,
        file,
        type,
        title: title || file.name,
        notes,
        isSensitive,
      });
      onDocumentUploaded(document);
      resetForm();
    } catch {
      // useUploadTripDocument surfaces isError/error to the form below
    }
  }

  async function handleOpen(documentId: string) {
    setOpeningId(documentId);
    try {
      const url = await openDocument.mutateAsync({ iso: isoA2, itineraryId: draft.id, documentId });
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setOpeningId(null);
    }
  }

  async function handleDelete(documentId: string) {
    setDeletingId(documentId);
    try {
      await deleteDocument.mutateAsync({ iso: isoA2, itineraryId: draft.id, documentId });
      removeDocumentLocal(onPatchDraft, documentId);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground">ארנק נסיעות</h3>
          <p className="text-sm text-muted-foreground">
            כרטיסים, אישורים ומסמכים לטיול. מסמכים רגישים נפתחים רק בלחיצה מפורשת.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setFormOpen((current) => !current)}>
          <Plus className="size-4" />
          הוסף מסמך
        </Button>
      </div>

      {formOpen ? (
        <div className="section-card space-y-3 p-4">
          <Input type="file" accept="application/pdf,image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <div className="grid gap-3 md:grid-cols-2">
            <Select value={type} onValueChange={(value) => setType(value as TripDocumentType)}>
              <SelectTrigger size="sm" className="w-full">
                <span>{TRIP_DOCUMENT_TYPE_LABELS[type]}</span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TRIP_DOCUMENT_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="כותרת" />
          </div>
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="הערות" rows={2} />
          <div className="flex items-center gap-2">
            <Switch checked={isSensitive} onCheckedChange={setIsSensitive} />
            <span className="text-sm text-muted-foreground">מסמך רגיש (למשל דרכון, ויזה, ביטוח)</span>
          </div>
          {uploadDocument.isError ? (
            <p className="text-sm text-destructive">
              {uploadDocument.error instanceof Error ? uploadDocument.error.message : "העלאת המסמך נכשלה."}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleUpload} disabled={!file || uploadDocument.isPending}>
              {uploadDocument.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              העלה מסמך
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              ביטול
            </Button>
          </div>
        </div>
      ) : null}

      {documentList.length === 0 ? (
        <div className="section-card flex flex-col items-center gap-2 p-8 text-center">
          <FileText className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">עדיין לא שמרת מסמכי נסיעה.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {documentList.map((document) => (
            <DocumentCard
              key={document.id}
              document={document}
              onOpen={() => void handleOpen(document.id)}
              onDelete={() => void handleDelete(document.id)}
              isOpening={openingId === document.id}
              isDeleting={deletingId === document.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}
