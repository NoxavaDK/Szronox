/**
 * T06 controlled-screen contracts.
 *
 * These screens never fetch or persist data (AGENTS.md, T00 route surface). Every
 * prop here is render-ready state or a callback intent; T08 owns controllers,
 * adapters and translating wire responses (`packages/contracts`) into these
 * shapes. Do not weaken or fork the canonical wire types imported below — derive
 * view types from them with `Pick`/unions instead of redeclaring fields.
 */
import type { Id, Priority, ReelHook, ReelStatus, User, VerificationState } from '@szronox/contracts';

export type EditorView = Pick<User, 'id' | 'name' | 'avatarUrl'>;

/** Initial fetch/list state. Distinct from per-field `SaveState` below. */
export type LoadState = 'idle' | 'loading' | 'loaded' | 'error' | 'offline';

/** Per-mutation feedback. Never rendered as a permanent "Zapisano" (frozen-visual-spec.md sec. 4). */
export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';

// ---------------------------------------------------------------------------
// ReelListScreen — "Rolki" (frozen-visual-spec.md sec. 2)
// ---------------------------------------------------------------------------

export interface StatusTabView {
  status: ReelStatus;
  label: string;
  /** Omit to render the tab without a count (spec shows Gotowe/Opublikowane bare). */
  count?: number;
}

export interface ReelListItemView {
  id: Id;
  title: string;
  priority: Priority;
  editor: EditorView | null;
  /** True when the item has crossed an attention threshold (T08-computed; T06 only renders). */
  isOverdue: boolean;
  /** Render-ready elapsed-time label, e.g. "26 godz. w montażu"; null when not applicable. */
  elapsedLabel: string | null;
  /** Only meaningful when a current export exists; a Reel with no export has no verification state. */
  verificationState: VerificationState | null;
  programmeState: 'unchecked' | 'matched' | 'no_match';
  /** Name of the single attached meme, if any; the list shows at most one. */
  memeName: string | null;
  feedCoverDone: boolean;
}

export interface ReelListScreenProps {
  currentUser: EditorView;
  statusTabs: StatusTabView[];
  selectedStatus: ReelStatus;
  onSelectStatus: (status: ReelStatus) => void;
  /** Count of items needing attention across all statuses; omit/0 hides the strip. */
  attentionCount?: number;
  onOpenAttention?: () => void;
  loadState: LoadState;
  items: ReelListItemView[];
  onOpenReel: (id: Id) => void;
  onAddNew: () => void;
  onRetry?: () => void;
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
   * selector starts collapsed to a compact chip until `onChangeType` is called
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
// ReelDetailScreen (frozen-visual-spec.md sec. 4)
// ---------------------------------------------------------------------------

export type HookView = Pick<ReelHook, 'id' | 'text' | 'source' | 'position'>;

export interface ReelDetailMetadataView {
  status: ReelStatus;
  statusLabel: string;
  priority: Priority;
  editor: EditorView | null;
  programmeState: 'unchecked' | 'matched' | 'no_match';
  memeName: string | null;
  feedCoverDone: boolean;
  /** Null when there is no current export — the screen must render no verification chip at all. */
  verificationState: VerificationState | null;
}

export interface ReelDetailScreenProps {
  onBack: () => void;
  title: string;
  onChangeTitle: (value: string) => void;
  onOpenOverflowMenu: () => void;

  metadata: ReelDetailMetadataView;
  onOpenFeedCover: () => void;

  hooks: HookView[];
  onRemoveHook: (id: Id) => void;

  script: string;
  onChangeScript: (value: string) => void;

  /** The compact Fakty / Aa Język / ✦ Opracuj row; capability-disabled for this milestone. */
  aiRowEnabled: false;

  sourcesSummary?: string;
  onOpenSources: () => void;
  materialsSummary?: string;
  onOpenMaterials: () => void;
  editingNotesSummary?: string;
  onOpenEditingNotes: () => void;

  publicationExpanded: boolean;
  onTogglePublication: () => void;
  publication: PublicationSectionProps;

  saveState: SaveState;
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
  /** True once at least one reference asset is attached; the completion control below is independent of this. */
  hasFeedCoverAsset: boolean;
  onToggleFeedCoverDone: () => void;
  onAddOrChangeFeedCoverAsset: () => void;
  onOpenFeedCoverAsset: () => void;

  description: string;
  onChangeDescription: (value: string) => void;

  hashtags: string;
  onChangeHashtags: (value: string) => void;

  /**
   * Intent only: the exact two-newline join, empty-field rule and clipboard
   * failure handling are T08's responsibility (T08 sec. 8), not this component's.
   */
  onCopyDescription: () => void;

  publishedAt: string | null;
  publicationLinks: PublicationLinkView[];
  onAddPublicationLink: () => void;
  onOpenPublicationLink: (id: Id) => void;
}
