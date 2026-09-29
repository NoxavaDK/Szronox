/**
 * snake_case rows to camelCase wire types.
 *
 * Column names never leak past this module, and the wire types are imported from
 * `@szronox/contracts` rather than restated, so drift fails typecheck instead of
 * shipping.
 */

import type {
  AttachmentReference,
  CaptureInput,
  ExportReference,
  Reel,
  ReelHook,
  VerificationRecord,
  VerificationState,
} from '@szronox/contracts';

export interface ReelRow {
  id: string;
  version: number;
  title: string;
  status: Reel['status'];
  priority: Reel['priority'];
  input_note: string;
  original_input: CaptureInput;
  script: string;
  script_revision: number;
  editing_notes: string;
  editor_id: string | null;
  selected_hook_id: string | null;
  current_export: ExportReference | null;
  verification: VerificationRecord | null;
  programme_state: Reel['programmeState'];
  programme_attachment: Reel['programmeAttachment'];
  programme_input_hash: string | null;
  programme_document_version_id: string | null;
  kdrive_folder: Reel['kdriveFolder'];
  editing_started_at: Date | string | null;
  published_at: Date | string | null;
  publication_urls: string[];
  publication_description: string;
  publication_hashtags: string;
  feed_cover_done: boolean;
  feed_cover_asset: Reel['feedCoverAsset'];
  /** Selected as text (`YYYY-MM-DD`), so no driver date parsing shifts the day. */
  planned_publication_date: string | null;
  planned_publication_slot: Reel['plannedPublicationSlot'];
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

export interface HookRow {
  id: string;
  reel_id: string;
  text: string;
  source: 'user' | 'ai';
  position: number;
  created_at: Date | string;
}

export interface AttachmentRow {
  id: string;
  reel_id: string;
  purpose: AttachmentReference['purpose'];
  kind: AttachmentReference['kind'];
  label: string;
  url: string | null;
  storage_key: string | null;
  state: AttachmentReference['state'];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return iso(value) as string;
}

export function toHook(row: HookRow): ReelHook {
  return {
    id: row.id,
    reelId: row.reel_id,
    text: row.text,
    source: row.source,
    position: row.position,
    createdAt: isoRequired(row.created_at),
  };
}

export function toAttachment(row: AttachmentRow): AttachmentReference {
  const reference: AttachmentReference = {
    id: row.id,
    reelId: row.reel_id,
    purpose: row.purpose,
    kind: row.kind,
    label: row.label,
    state: row.state,
  };
  // Optional fields are omitted rather than sent as null, matching the contract.
  if (row.url !== null) reference.url = row.url;
  if (row.storage_key !== null) reference.storageKey = row.storage_key;
  return reference;
}

/**
 * Derive verification state.
 *
 * T00: without an export there is no verification state at all, which is `null`
 * rather than `not_verified`. A check recorded against an older export revision
 * derives `outdated`, which is why the historical record is retained instead of
 * being cleared on replacement.
 */
export function deriveVerificationState(
  currentExport: ExportReference | null,
  verification: VerificationRecord | null,
): VerificationState | null {
  if (currentExport === null) return null;
  if (verification === null) return 'not_verified';
  return verification.exportRevision === currentExport.revision ? 'verified' : 'outdated';
}

export function toReel(
  row: ReelRow,
  hooks: HookRow[],
  attachments: AttachmentRow[],
  memeIds: string[],
): Reel {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    status: row.status,
    priority: row.priority,
    inputNote: row.input_note,
    originalInput: row.original_input,
    script: row.script,
    scriptRevision: row.script_revision,
    editingNotes: row.editing_notes,
    editorId: row.editor_id,
    hooks: hooks.map(toHook),
    selectedHookId: row.selected_hook_id,
    memeIds,
    attachments: attachments.map(toAttachment),
    currentExport: row.current_export,
    verification: row.verification,
    verificationState: deriveVerificationState(row.current_export, row.verification),
    programmeState: row.programme_state,
    programmeAttachment: row.programme_attachment,
    programmeInputHash: row.programme_input_hash,
    programmeDocumentVersionId: row.programme_document_version_id,
    kdriveFolder: row.kdrive_folder,
    editingStartedAt: iso(row.editing_started_at),
    publishedAt: iso(row.published_at),
    publicationUrls: row.publication_urls,
    publicationDescription: row.publication_description,
    publicationHashtags: row.publication_hashtags,
    feedCoverDone: row.feed_cover_done,
    feedCoverAsset: row.feed_cover_asset ?? null,
    plannedPublicationDate: row.planned_publication_date ?? null,
    plannedPublicationSlot: row.planned_publication_slot ?? null,
    createdBy: row.created_by,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}
