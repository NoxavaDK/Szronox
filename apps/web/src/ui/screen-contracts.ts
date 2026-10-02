/**
 * T06 controlled-screen contracts.
 *
 * These screens never fetch or persist data (AGENTS.md, T00 route surface). Every
 * prop here is render-ready state or a callback intent; T08 owns controllers,
 * adapters and translating wire responses (`packages/contracts`) into these
 * shapes. Do not weaken or fork the canonical wire types imported below — derive
 * view types from them with `Pick`/unions instead of redeclaring fields.
 *
 * ── Updated for the frozen Reel Detail batch ────────────────────────────────
 *
 * The first version of this file predated `design/frozen-reel-detail-language-spec.md`.
 * T08 reported the consequences precisely: no controlled status/priority/editor
 * selection, no editors for `inputNote` or `editingNotes`, no controlled
 * Materials/export/verification state, and no deleted-list/restore or
 * conflict-recovery callbacks — so it had to work around the interface instead of
 * wiring it.
 *
 * This revision adds all of those. Every Polish string that the spec pins is
 * exported as a constant here rather than typed into a component, so the frozen
 * copy has exactly one definition and a test can assert it.
 */
import type {
  Id,
  Priority,
  ReelHook,
  ReelStatus,
  User,
  VerificationState,
} from '@szronox/contracts';

export type EditorView = Pick<User, 'id' | 'name' | 'avatarUrl'>;

/** Initial fetch/list state. Distinct from per-field `SaveState` below. */
export type LoadState = 'idle' | 'loading' | 'loaded' | 'error' | 'offline';

/** Per-mutation feedback. Never rendered as a permanent "Zapisano" (frozen-visual-spec.md sec. 4). */
export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';

// ---------------------------------------------------------------------------
// Frozen Polish copy
// ---------------------------------------------------------------------------

/** Status labels, exactly as the spec pins them (sec. 3 STATUS). */
export const STATUS_LABELS: Record<ReelStatus, string> = {
  idea: 'Pomysł',
  to_record: 'Do nagrania',
  editing: 'Montaż',
  ready: 'Gotowe',
  published: 'Opublikowane',
};

/**
 * The canonical product pipeline order. Single source of truth: both the STATUS sheet
 * (`detail-sections.tsx`) and the list's swipe-right "next status" gesture (LIST-01) must
 * agree on it, or a swipe could reveal a target the sheet would never itself suggest.
 */
export const STATUS_ORDER: ReelStatus[] = ['idea', 'to_record', 'editing', 'ready', 'published'];

/**
 * The one unambiguous next status in the pipeline, or `null` when there isn't one.
 *
 * `published` is the only status with no successor. The order above is strictly linear, so
 * "unambiguous" always holds for every other status — there is no branching workflow to
 * guess between. If that ever changes, this is the one place a real ambiguity should be
 * expressed, by returning `null` for it too; callers already treat `null` as "offer the
 * full status sheet instead" (LIST-01: "never guess").
 */
export function nextReelStatus(status: ReelStatus): ReelStatus | null {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 || index === STATUS_ORDER.length - 1 ? null : STATUS_ORDER[index + 1];
}

/** Primary list navigation labels. `Usunięte` is deliberately NOT among them. */
export const STATUS_TAB_LABELS: Record<ReelStatus, string> = {
  idea: 'Pomysły',
  to_record: 'Do nagrania',
  editing: 'Montaż',
  ready: 'Gotowe',
  published: 'Opublikowane',
};

/** Priority labels including their glyphs (sec. 3 PRIORYTET). */
export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '! Pilne',
  normal: '● Normalne',
  evergreen: '∞ Evergreen',
};

/**
 * Attention thresholds in hours, per priority. The frozen batch maps the
 * 24/96/168 thresholds onto priorities; T06 only renders, T08 computes.
 */
export const ATTENTION_THRESHOLD_HOURS: Record<Priority, number> = {
  urgent: 24,
  normal: 96,
  evergreen: 168,
};

export const COPY = {
  /** CONTENT-PLANNER-01 list quick action. */
  schedule: 'Zaplanuj',
  plannerIdeas: 'POMYSŁY',
  plannerIdeasHint: 'Zaplanowanie zmieni status na „Do nagrania”.',
  scheduleIdeaHint: 'Po zaplanowaniu pomysł trafi do „Do nagrania”.',
  scheduleIdeaPromoted: 'Przeniesiono do „Do nagrania”',
  /** sec. 3 — the editor may legitimately be null. */
  editorNone: 'Brak',
  editorSectionLabel: 'MONTUJE',
  statusHeading: 'STATUS',
  priorityHeading: 'PRIORYTET',
  editorHeading: 'MONTUJE',

  /** sec. 3 STATUS — the publish gate, already frozen. */
  feedCoverRequired: 'Przed zmianą statusu na „Opublikowane” oznacz „Okładka do feedu” jako ukończoną.',

  /** sec. 5 */
  sourcesHeading: 'ŹRÓDŁA / WEJŚCIE',
  originalInputHeading: 'ORYGINALNE WEJŚCIE',
  originalLinkLabel: 'LINK',
  originalTextLabel: 'TEKST',
  openSource: 'Otwórz źródło',
  additionalTextHeading: 'DODATKOWY TEKST',
  attachmentsHeading: 'ZAŁĄCZNIKI',
  inputNoteHeading: 'NOTATKA DO WEJŚCIA',

  /** sec. 6 */
  editingNotesHeading: 'UWAGI DO MONTAŻU',

  /** sec. 2 */
  materialsHeading: 'MATERIAŁY',
  kdriveHeading: 'FOLDER kDrive',
  kdriveMissing: 'Brak folderu',
  kdriveCreate: '+ Utwórz folder kDrive',
  kdriveOpen: 'Otwórz kDrive',
  exportHeading: 'AKTUALNY EKSPORT',
  exportMissing: 'Brak',
  exportReplace: 'Zmień eksport',
  verificationHeading: 'WERYFIKACJA',
  verificationNeedsEditor: 'Wybierz montażystę, aby wskazać osobę sprawdzającą.',
  verificationUnverified: '○ Nie sprawdzone',
  verificationMarkVerified: 'Oznacz jako sprawdzony',
  verificationOutdated: '◷ Nieaktualne',
  /** UI-02 attention wording for a stale verification: distinct from verified and from failed. */
  verificationRecheck: 'Eksport zmieniony · Sprawdź ponownie',
  verificationMarkNewVerified: 'Oznacz nowy eksport jako sprawdzony',

  /** sec. 7 */
  deleteReel: 'Usuń rolkę',
  deleteConfirmTitle: 'Usunąć rolkę?',
  deleteConfirmBody: 'Rolka zniknie z aktywnych widoków. Będzie można ją później przywrócić.',
  deleteCancel: 'Anuluj',
  deleteConfirm: 'Usuń',

  /** sec. 8 */
  deletedEntry: 'Usunięte',
  restoreReel: 'Przywróć rolkę',

  /** LIST-01 — list quick actions. Reuses `statusHeading`/`editorHeading`/`kdriveOpen`/`deleteReel` above. */
  quickActionsHeading: 'Szybkie akcje',
  changeStatus: 'Zmień status',
  assignEditor: 'Przypisz',
  copyLink: 'Kopiuj link',
  moreActions: 'Więcej',
  undo: 'Cofnij',
  /** One definition, reused by Reel Detail's Materials section and the list quick actions. */
  kdriveUnavailable: 'Integracja kDrive nie jest jeszcze dostępna.',
} as const;

/** `Zmieniono status na „Montaż”.` — LIST-01 undo-snackbar confirmation after a quick move. */
export function statusChangedLabel(statusLabel: string): string {
  return `Zmieniono status na „${statusLabel}”.`;
}

/** `○ Czeka na <peer>` — sec. 2, using the actual peer identity. */
export function awaitingVerifierLabel(peerName: string): string {
  return `○ Czeka na ${peerName}`;
}

/** `✓ <verifier>` — sec. 2, using the actual verifier identity. */
export function verifiedByLabel(verifierName: string): string {
  return `✓ ${verifierName}`;
}

/** `Poprzedni eksport sprawdził <verifier>.` — sec. 2 outdated explanation. */
export function previousExportVerifiedBy(verifierName: string): string {
  return `Poprzedni eksport sprawdził ${verifierName}.`;
}

// ---------------------------------------------------------------------------
// Conflict recovery (T08 dependency)
// ---------------------------------------------------------------------------

/**
 * A 409 keeps the local draft and offers explicit recovery. T06 renders the
 * choice; it never resolves the conflict itself and never silently overwrites.
 */
export interface ConflictRecoveryView {
  /** Which field the conflict concerns, for a precise notice. */
  field: string;
  /** The value the user still has locally. Never discarded by rendering. */
  localValue: string;
  /** The authoritative server value. */
  serverValue: string;
  /** Keep editing from the local draft, discarding nothing. */
  onKeepLocal: () => void;
  /** Adopt the server value, explicitly abandoning the local edit. */
  onUseServer: () => void;
  onDismiss: () => void;
}

// ---------------------------------------------------------------------------
// Metadata selectors — sec. 3
// ---------------------------------------------------------------------------

/**
 * One selector sheet. Mobile renders a compact bottom sheet; desktop may use an
 * equivalent popover. One explicit selection applies the mutation — there is no
 * additional Save action, and dismissal without selection changes nothing.
 */
export type MetadataSelector = 'status' | 'priority' | 'editor';

export interface MetadataSelectorsProps {
  /** Which sheet is open, or null when none is. */
  open: MetadataSelector | null;
  onOpen: (selector: MetadataSelector) => void;
  onDismiss: () => void;

  status: ReelStatus;
  onSelectStatus: (status: ReelStatus) => void;

  priority: Priority;
  onSelectPriority: (priority: Priority) => void;

  /** Null is legitimate: a Reel may have no editor. */
  editor: EditorView | null;
  /** Exactly the two allowlisted users, in the order the sheet should list them. */
  editorOptions: EditorView[];
  /** `null` selects `Brak`. */
  onSelectEditor: (editorId: Id | null) => void;

  /**
   * Set when the last selection failed. The authoritative value stays rendered and
   * no false success is shown.
   */
  selectionError: string | null;
  saveState: SaveState;
}

// ---------------------------------------------------------------------------
// ŹRÓDŁA / WEJŚCIE — sec. 5
// ---------------------------------------------------------------------------

export interface SourceAttachmentView {
  id: Id;
  fileName: string;
  /** Null while unavailable; the row still renders rather than being omitted. */
  thumbnailUrl: string | null;
  /**
   * True for descriptors preserved from the original capture that were never
   * accepted as uploads. They must NOT be presented as successfully uploaded.
   */
  unsupported: boolean;
}

export interface SourcesSectionProps {
  expanded: boolean;
  onToggle: () => void;
  summary?: string | null;

  /** Original captured URL, if the Reel came from a link. Never rewritten. */
  originalUrl: string | null;
  onOpenSource: () => void;
  sourceLink: string | null;
  onChangeSourceLink: (value: string | null) => void;
  focusArticleLink?: number;
  /** Original captured text, if any. */
  originalText: string | null;
  /** Additional text typed during Quick Add alongside a URL/image, kept separate. */
  additionalText: string | null;

  attachments: SourceAttachmentView[];
  onOpenAttachment: (id: Id) => void;

  /**
   * Mutable user note. NOT part of immutable `originalInput`: editing it must never
   * rewrite the original capture.
   */
  inputNote: string;
  onChangeInputNote: (value: string) => void;
  inputNoteSaveState: SaveState;
  inputNoteConflict?: ConflictRecoveryView;
  /** UI-02: a deleted Reel shows its sources without an editable note. */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// UWAGI DO MONTAŻU — sec. 6
// ---------------------------------------------------------------------------

/**
 * One shared editable production note. Deliberately a single plain-text field:
 * no threads, no per-user notes, no checklists, no timestamps per line.
 */
export interface EditingNotesSectionProps {
  expanded: boolean;
  onToggle: () => void;
  summary?: string;
  value: string;
  onChange: (value: string) => void;
  saveState: SaveState;
  conflict?: ConflictRecoveryView;
}

// ---------------------------------------------------------------------------
// MATERIAŁY — sec. 2
// ---------------------------------------------------------------------------

export interface KdriveFolderView {
  /** Null when no folder is linked yet. */
  name: string | null;
  /**
   * True when the stored reference exists but the folder is missing, moved or
   * inaccessible. The reference is preserved and relinking is offered; a
   * replacement is never created silently.
   */
  unavailable: boolean;
  /** KDRIVE-01b: one short Polish line about the resolved state (checking, deleted, no access…). */
  note?: string | null;
}

export interface CurrentExportView {
  /** Null when there is no export — then no verification state is rendered at all. */
  label: string | null;
  revision: number | null;
}

/**
 * Verification is derived, never chosen. The verifier is the peer of the selected
 * editor; there is no verifier selector.
 */
export type VerificationViewState =
  | { kind: 'no_export' }
  | { kind: 'needs_editor' }
  /** Current user IS the editor, so they cannot verify their own export. */
  | { kind: 'awaiting_peer'; peerName: string }
  /** Current user is the expected verifier and this revision is unverified. */
  | { kind: 'unverified_by_me' }
  | { kind: 'verified'; verifierName: string }
  /** Export changed after verification. */
  | { kind: 'outdated'; previousVerifierName: string; canVerifyNewRevision: boolean };

export interface MaterialsSectionProps {
  expanded: boolean;
  onToggle: () => void;
  summary?: string;

  kdriveFolder: KdriveFolderView;
  onCreateKdriveFolder: () => void;
  onOpenKdriveFolder: () => void;
  onRelinkKdriveFolder: () => void;
  /** kDrive may be unavailable for this milestone; the row states it honestly. */
  kdriveEnabled: boolean;

  currentExport: CurrentExportView;
  onOpenExport: () => void;
  /** Every explicit replacement creates a new revision, even for the same file. */
  onReplaceExport: () => void;
  onUploadVideo?: () => void;
  uploadEnabled?: boolean;
  uploadJob?: KdriveUploadView | null;
  onCancelUpload?: () => void;
  onRetryUpload?: () => void;

  verification: VerificationViewState;
  onMarkVerified: () => void;

  saveState: SaveState;
}

// ---------------------------------------------------------------------------
// ReelListScreen — "Rolki" (frozen-visual-spec.md sec. 2)
// ---------------------------------------------------------------------------

export interface StatusTabView {
  status: ReelStatus | 'all';
  label: string;
  /** Omit to render the tab without a count (spec shows Gotowe/Opublikowane bare). */
  count?: number;
}

export interface ReelListItemView {
  id: Id;
  /** Optimistic-concurrency token for mutations issued directly from the list (LIST-01). */
  version: number;
  status: ReelStatus;
  /** True when a kDrive folder reference is stored, whether or not opening it is enabled. */
  hasKdriveFolder: boolean;
  /**
   * What to show in the title slot — an authored title, or a label derived from the capture
   * when there is none. Never empty: a blank row is not a state the list can render.
   */
  title: string;
  /**
   * True when `title` was derived rather than typed. Presented more quietly, so a derived
   * label does not read as a title someone wrote. Optional: absent means authored.
   */
  titleIsDerived?: boolean;
  /** Link host shown as secondary information when this capture included a URL. */
  sourceDomain?: string;
  priority: Priority;
  editor: EditorView | null;
  /** True when the item has crossed its priority's attention threshold (T08-computed). */
  isOverdue: boolean;
  /** Render-ready elapsed-time label, e.g. "26 godz. w montażu"; null when not applicable. */
  elapsedLabel: string | null;
  /** Only meaningful when a current export exists; no export means no verification state. */
  verificationState: VerificationState | null;
  programmeState: 'unchecked' | 'matched' | 'no_match';
  /** Name of the single attached meme, if any; the list shows at most one. */
  memeName: string | null;
  feedCoverDone: boolean;
  /** CONTENT-PLANNER-01: short plan label (`Jutro, 18:00`), or null/absent when unplanned. */
  planLabel?: string | null;
}

// ---------------------------------------------------------------------------
// List quick actions and gestures (LIST-01)
// ---------------------------------------------------------------------------

/**
 * Which quick-actions surface is open for a row, and for which Reel.
 *
 * `sheet` is the long-press / swipe-left "Więcej" bottom sheet. `status` and `assign` are
 * the same two selections reachable from inside that sheet, but may also be opened directly
 * (the sheet's own items, or an unambiguous swipe-right commits instead of opening `status`).
 * Only one row's surface is open at a time; opening another closes the previous one — this
 * is state, not merely visual, because it is what "closes on view change" observably means.
 */
export type ListQuickActionsView = 'sheet' | 'status' | 'assign' | 'radial' | null;

export interface ReelUndoView {
  message: string;
  onUndo: () => void;
  /** The undo request's own state; distinct from the move it is undoing. */
  saveState: SaveState;
}

export interface ReelQuickActionsProps {
  /** Reel id the open surface belongs to; `null` reel id means nothing is open. */
  openReelId: Id | null;
  open: ListQuickActionsView;
  onOpenSheet: (id: Id) => void;
  /**
   * UI-02: a touch long-press opens the small radial menu at the touch point instead of the
   * sheet. Optional — without it a long-press keeps opening the sheet. `radialAnchor` is the
   * viewport point it opened at, set only while `open === 'radial'`.
   */
  onOpenRadial?: (id: Id, anchor: { x: number; y: number }) => void;
  radialAnchor?: { x: number; y: number } | null;
  /** The ambiguous-successor case ("never guess"), and the sheet's own `Zmień status` item. */
  onOpenStatus: (id: Id) => void;
  onOpenAssign: (id: Id) => void;
  onDismiss: () => void;

  /** Exactly the two allowlisted users, for the Przypisz sheet. */
  editorOptions: EditorView[];
  onSelectStatus: (id: Id, status: ReelStatus) => void;
  onSelectEditor: (id: Id, editorId: Id | null) => void;
  /** The unambiguous swipe-right pill commits directly, without opening the sheet. */
  onQuickAdvanceStatus: (id: Id, status: ReelStatus) => void;
  onCopyLink: (id: Id) => void;
  /** `Zaplanuj` (CONTENT-PLANNER-01): opens the shared plan sheet for this Reel. Optional. */
  onOpenSchedule?: (id: Id) => void;
  /** kDrive integration is not yet enabled anywhere in the product; the row states that honestly. */
  kdriveEnabled: boolean;
  onOpenKdrive: (id: Id) => void;

  onRequestDelete: (id: Id) => void;
  confirmingDeleteId: Id | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;

  selectionError: string | null;
  saveState: SaveState;
  undo: ReelUndoView | null;
}

export interface ReelListScreenProps {
  currentUser: EditorView;
  statusTabs: StatusTabView[];
  selectedStatus: ReelStatus | 'all';
  onSelectStatus: (status: ReelStatus | 'all') => void;
  searchQuery?: string;
  onChangeSearchQuery?: (value: string) => void;
  /** Count of items needing attention across all statuses; omit/0 hides the strip. */
  attentionCount?: number;
  onOpenAttention?: () => void;
  loadState: LoadState;
  items: ReelListItemView[];
  /** Currently open Reel, highlighted even if a changed filter no longer includes its status. */
  selectedReelId?: Id | null;
  onOpenReel: (id: Id) => void;
  onAddNew: () => void;
  onRetry?: () => void;
  /**
   * `Usunięte` is a quiet secondary entry from the screen-level overflow menu —
   * never a sixth status and never a primary tab.
   */
  onOpenDeleted: () => void;
  /** CONTENT-PLANNER-01: the mobile entry to the PLAN view. Absent when PLAN is already on screen. */
  onOpenPlan?: () => void;
  /** Quiet account action; shown only when the list occupies the full screen. */
  onSignOut?: () => void;
  /** Rendered as a side pane: the fixed Nowy pomysł button stays within the pane's own column. */
  embedded?: boolean;

  /** Long-press / swipe-reveal quick actions (LIST-01). Optional: omitting it disables gestures cleanly. */
  quickActions?: ReelQuickActionsProps;
}

// ---------------------------------------------------------------------------
// Deleted Reels — sec. 8
// ---------------------------------------------------------------------------

/**
 * Uses the existing Reel-list visual language; no new card layout. Deleted Reels
 * are excluded from every normal status list.
 */
export interface DeletedReelsScreenProps {
  onBack: () => void;
  loadState: LoadState;
  items: ReelListItemView[];
  onOpenReel: (id: Id) => void;
  onRetry?: () => void;
}

/** The restore affordance shown when a deleted Reel is opened. */
export interface RestoreBannerProps {
  onRestore: () => void;
  saveState: SaveState;
}

// ---------------------------------------------------------------------------
// QuickAddScreen — "Nowy pomysł" (frozen-visual-spec.md sec. 3)
// ---------------------------------------------------------------------------

export type CaptureKind = 'image' | 'url' | 'text';

export interface QuickAddImageView {
  /** Local attachment id the caller correlates back to its own upload queue. */
  id: Id;
  fileName: string;
  /** Object URL / data URL for the compact 80x80 thumbnail; null while unavailable. */
  previewUrl: string | null;
}

export interface QuickAddScreenProps {
  onBack: () => void;
  /**
   * Present when the screen was opened from a share/detected payload: the type
   * selector starts collapsed to a compact chip until `onChangeKind` is called
   * (the sec. 3 "Zmień" affordance), rather than showing the full tab selector.
   */
  detectedKind: CaptureKind | null;
  selectedKind: CaptureKind;
  onChangeKind: (kind: CaptureKind) => void;

  url: string;
  onChangeUrl: (value: string) => void;

  images: QuickAddImageView[];
  onAddImage: () => void;
  onRemoveImage: (id: Id) => void;

  text: string;
  onChangeText: (value: string) => void;
  textMode: 'idea' | 'script';
  onChangeTextMode: (value: 'idea' | 'script') => void;

  /** Optional accompanying text/hook fields are hidden until requested. */
  showAccompanyingText: boolean;
  onRevealAccompanyingText: () => void;
  accompanyingText: string;
  onChangeAccompanyingText: (value: string) => void;

  showHookField: boolean;
  onRevealHookField: () => void;
  initialHook: string;
  onChangeInitialHook: (value: string) => void;

  priority: Priority;
  onChangePriority: (priority: Priority) => void;

  canSave: boolean;
  onSave: () => void;
  onOpracuj: () => void;

  saveState: SaveState;
}

// ---------------------------------------------------------------------------
// ReelDetailScreen (frozen-visual-spec.md sec. 4 + the frozen Reel Detail batch)
// ---------------------------------------------------------------------------

export type HookView = Pick<ReelHook, 'id' | 'text' | 'source' | 'position'>;

/** An inline edit of one existing hook, kept until Gotowe succeeds or the user cancels. */
export interface HookEditView {
  text: string;
  saving: boolean;
  /** Truthful Polish reason the last save did not land; the text above is still the user's. */
  error: string | null;
}

export interface ReelDetailMetadataView {
  status: ReelStatus;
  statusLabel: string;
  priority: Priority;
  editor: EditorView | null;
  programmeState: 'unchecked' | 'matched' | 'no_match';
  memeName: string | null;
  feedCoverDone: boolean;
  /** Null when there is no current export — render no verification chip at all. */
  verificationState: VerificationState | null;
}

/**
 * The overflow menu is deliberately minimal: for an active Reel it holds only
 * `Usuń rolkę`. Status, priority, editor, AI, export, kDrive and meme actions all
 * have dedicated locations and must not appear here.
 */
export interface ReelOverflowProps {
  open: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onRequestDelete: () => void;
  /** Confirmation is a separate, explicit step with the frozen copy. */
  confirmingDelete: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  deleteState: SaveState;
}

export interface ReelDetailScreenProps {
  onBack: () => void;
  title: string;
  onChangeTitle: (value: string) => void;
  /**
   * Label to show while there is no authored title. A placeholder, so the field stays empty
   * and a derived label can never be saved as a title by accident. Absent when one exists.
   */
  titlePlaceholder?: string;
  sourceDomain?: string;

  metadata: ReelDetailMetadataView;
  /**
   * One phase-relevant shortcut to existing work; never changes status by itself. UI-02: chosen
   * by `detailPrimaryAction` (data/detail-actions.ts); `tone` is its semantic colour role.
   */
  contextAction?: { label: string; onClick: () => void; tone?: 'primary' | 'attention' | 'quiet' };
  /**
   * UI-02: a deleted Reel is read-only. Restore is the context action; editing, generation, hook
   * and meme controls are not rendered at all rather than shown as available.
   */
  readOnly?: boolean;
  /**
   * CONTENT-PLANNER-01 `Zaplanuj publikację`: the Reel's one plan, read from the Reel itself.
   * `label` is null when unplanned. Optional so fixtures without planning still render.
   */
  plan?: { label: string | null; onOpen: () => void };
  /** Controlled status/priority/MONTUJE selection (sec. 3). */
  selectors: MetadataSelectorsProps;
  overflow: ReelOverflowProps;
  onOpenFeedCover: () => void;

  /**
   * Present only when this Reel is soft-deleted. UI-02: `Przywróć rolkę` is then the primary
   * context action; the banner only explains the state and reports the restore's progress.
   */
  restore?: RestoreBannerProps;

  hooks: HookView[];
  onRemoveHook: (id: Id) => void;
  /**
   * HOOKS-SELECT-EDIT. The one explicitly chosen hook, or null — valid and never inferred.
   * A row tap/Enter/Space selects it; on the already selected row it clears the choice.
   */
  selectedHookId: Id | null;
  onSelectHook: (id: Id) => void;
  /** A selection request is in flight; rows do not accept another until it answers. */
  hookSelectionPending: boolean;
  /**
   * Inline edits keyed by hook ID. A key with no matching hook is a draft whose hook was
   * deleted elsewhere; it stays visible so the text is not silently lost.
   */
  hookEdits: Record<Id, HookEditView>;
  onStartHookEdit: (id: Id) => void;
  onChangeHookEdit: (id: Id, text: string) => void;
  onSaveHookEdit: (id: Id) => void;
  onCancelHookEdit: (id: Id) => void;
  /** HOOK-ADD-01: the new-hook draft, or null when `+ Dodaj hook` is closed. */
  newHook: HookEditView | null;
  onStartNewHook: () => void;
  onChangeNewHook: (text: string) => void;
  onSaveNewHook: () => void;
  onCancelNewHook: () => void;

  script: string;
  onChangeScript: (value: string) => void;
  scriptConflict?: ConflictRecoveryView;

  /** The compact Fakty / Aa Język / ✦ Opracuj row. */
  aiRowEnabled: boolean;
  onAiAction?: (action: 'fact_check' | 'language_check' | 'develop') => void;
  onOpenMeme?: () => void;
  onDetachMeme?: (memeId: Id) => void;
  attachedMemes?: Array<{ id: Id; name: string }>;
  onOpenProgramme?: () => void;

  /** Expanded inline sections, in the frozen order. */
  sources: SourcesSectionProps;
  editingNotes: EditingNotesSectionProps;
  materials: MaterialsSectionProps;

  publicationExpanded: boolean;
  onTogglePublication: () => void;
  publication: PublicationSectionProps;

  saveState: SaveState;
  /** A conflict on a whole-Reel save, distinct from a per-field one. */
  conflict?: ConflictRecoveryView;
}

// ---------------------------------------------------------------------------
// PublicationSection — inline expanded Reel Detail section (frozen-visual-spec.md sec. 6)
// ---------------------------------------------------------------------------

export interface PublicationLinkView {
  id: Id;
  url: string;
}

export interface PublicationSectionProps {
  feedCoverDone: boolean;
  /** True once at least one reference asset is attached; completion is independent of it. */
  hasFeedCoverAsset: boolean;
  onToggleFeedCoverDone: () => void;
  onAddOrChangeFeedCoverAsset: () => void;
  onOpenFeedCoverAsset: () => void;
  kdriveEnabled?: boolean;
  createFolderForCover?: boolean;
  uploadJob?: KdriveUploadView | null;
  onCancelUpload?: () => void;
  onRetryUpload?: () => void;

  description: string;
  onChangeDescription: (value: string) => void;

  source: string;
  sourceManual: boolean;
  sourceAutomaticAvailable: boolean;
  /** `blocked` / `unsupported`: a final `failed` whose retry can't help (SOURCE-01a). */
  sourceMetadataState: 'pending' | 'found' | 'partial' | 'failed' | 'blocked' | 'unsupported' | 'no_url' | 'never' | null;
  onAddArticleLink: () => void;
  sourceLongWait: boolean;
  sourceUndoAvailable: boolean;
  onChangeSource: (value: string) => void;
  onRefreshSource: () => void;
  onRestoreAutomaticSource: () => void;
  onUndoRestoreSource: () => void;
  onCheckSource: () => void;

  hashtags: string;
  onChangeHashtags: (value: string) => void;

  /**
   * Intent only: the exact two-newline join, empty-field rule and clipboard
   * failure handling are T08's responsibility (T08 sec. 8), not this component's.
   */
  onCopyDescription: () => void;
  plan?: { label: string | null; onOpen: () => void };
  isPublished?: boolean;
  isReady?: boolean;
  /** UI-02: a deleted Reel shows its copy without edit, generate or copy-as-action emphasis. */
  readOnly?: boolean;

  /**
   * `Wygeneruj opis` (PUBLICATION-01): opens the publication proposal view generated from the
   * saved script. The host refuses, with an explanation, while any edit is unsaved.
   */
  onGeneratePublication?: () => void;
  generatePublicationEnabled?: boolean;
  generatePublicationHint?: string;

  publishedAt: string | null;
  publicationLinks: PublicationLinkView[];
  onAddPublicationLink: () => void;
  onOpenPublicationLink: (id: Id) => void;
}

export interface KdriveUploadView {
  purpose: 'video' | 'cover'; fileName: string; completedBytes: number; totalBytes: number;
  percent: number; phase: 'uploading' | 'finishing' | 'attaching' | 'error' | 'done'; error: string | null;
}
