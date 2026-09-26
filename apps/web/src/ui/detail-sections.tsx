/**
 * Controlled Reel Detail sections from the frozen Reel Detail batch.
 *
 * Every component here is presentational: all state arrives as props and every
 * change is a callback intent. None of them fetches, persists, or resolves a
 * conflict — T08 owns that. The frozen Polish copy comes from `COPY` in
 * screen-contracts, so there is exactly one definition of each string.
 *
 * Flat editorial treatment throughout: thin separators, compact actions, no cards,
 * no large CTA buttons, no chat/comment affordances.
 */
import './tokens.css';
import type { Priority, Id } from '@szronox/contracts';
import {
  COPY,
  PRIORITY_LABELS,
  STATUS_LABELS,
  STATUS_ORDER,
  awaitingVerifierLabel,
  previousExportVerifiedBy,
  verifiedByLabel,
  type ConflictRecoveryView,
  type EditingNotesSectionProps,
  type MaterialsSectionProps,
  type MetadataSelector,
  type MetadataSelectorsProps,
  type RestoreBannerProps,
  type ReelOverflowProps,
  type SourcesSectionProps,
} from './screen-contracts.js';
import { Avatar, PriorityGlyph, TextAction } from './primitives.js';
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, WarningIcon } from './icons.js';
import styles from './detail-sections.module.css';

const PRIORITY_ORDER: Priority[] = ['urgent', 'normal', 'evergreen'];

/** A collapsible inline section header with the frozen chevron affordance. */
function SectionHeader(
  { heading, summary, expanded, onToggle }: { heading: string; summary?: string; expanded: boolean; onToggle: () => void },
) {
  return (
    <button
      type="button"
      className={styles.sectionHeader}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <span className={styles.sectionHeading}>{heading}</span>
      {!expanded && summary ? <span className={styles.sectionHeaderSummary}>{summary}</span> : null}
      <span className={expanded ? styles.chevronOpen : styles.chevron} aria-hidden="true">
        <ChevronRightIcon />
      </span>
    </button>
  );
}

/**
 * Conflict recovery. Renders the choice and nothing else: the local value is never
 * discarded by rendering, and neither option is taken automatically.
 */
export function ConflictNotice({ conflict }: { conflict: ConflictRecoveryView }) {
  return (
    <div className={styles.conflict} role="alert">
      <p className={styles.conflictLead}>
        <WarningIcon aria-hidden="true" /> Ktoś zmienił tę rolkę w trakcie edycji.
      </p>
      <dl className={styles.conflictValues}>
        <dt>Twoja wersja</dt>
        <dd>{conflict.localValue || '—'}</dd>
        <dt>Wersja na serwerze</dt>
        <dd>{conflict.serverValue || '—'}</dd>
      </dl>
      <div className={styles.conflictActions}>
        <TextAction onClick={conflict.onKeepLocal}>Zachowaj moją wersję</TextAction>
        <TextAction onClick={conflict.onUseServer}>Użyj wersji z serwera</TextAction>
        <TextAction onClick={conflict.onDismiss}>{COPY.deleteCancel}</TextAction>
      </div>
    </div>
  );
}

/** Quiet per-field save feedback. Never a permanent "Zapisano". */
function SaveHint({ state }: { state: MetadataSelectorsProps['saveState'] }) {
  if (state === 'idle' || state === 'saved') return null;
  const text = state === 'saving'
    ? 'Zapisywanie…'
    : state === 'offline'
      ? 'Brak połączenia — zapisano lokalnie'
      : state === 'conflict'
        ? 'Konflikt edycji'
        : 'Nie udało się zapisać';
  return <p className={styles.saveHint} role="status">{text}</p>;
}

// ── Metadata selectors: STATUS / PRIORYTET / MONTUJE (sec. 3) ───────────────

/**
 * Compact metadata controls. Tapping a value opens a bottom sheet; one explicit
 * selection applies the mutation, with no extra Save step. Dismissing without
 * selecting changes nothing.
 */
export function MetadataSelectors(props: MetadataSelectorsProps) {
  const { open, onOpen, onDismiss, status, priority, editor, editorOptions, selectionError, saveState } = props;

  const sheet = (selector: MetadataSelector, heading: string, body: React.ReactNode) => (
    open === selector ? (
      <div className={styles.sheetBackdrop} onClick={onDismiss} role="presentation">
        <div
          className={styles.sheet}
          role="dialog"
          aria-modal="true"
          aria-label={heading}
          onClick={(event) => event.stopPropagation()}
        >
          <h2 className={styles.sheetHeading}>{heading}</h2>
          {body}
        </div>
      </div>
    ) : null
  );

  return (
    <div className={styles.metadata}>
      <div className={styles.metadataRow}>
        <button type="button" className={styles.metadataValue} onClick={() => onOpen('status')}>
          <span className={styles.metadataLabel}>{COPY.statusHeading}</span>
          <span className={status === 'ready' ? styles.readyStatus : undefined}>
            {status === 'ready' ? <><CheckIcon aria-hidden="true" /> Gotowe</> : STATUS_LABELS[status]}
          </span>
        </button>
        <button type="button" className={styles.metadataValue} onClick={() => onOpen('priority')}>
          <span className={styles.metadataLabel}>{COPY.priorityHeading}</span>
          <span><PriorityGlyph priority={priority} /> {PRIORITY_LABELS[priority].replace(/^\S+\s/, '')}</span>
        </button>
        <button type="button" className={styles.metadataValue} onClick={() => onOpen('editor')}>
          <span className={styles.metadataLabel}>{COPY.editorSectionLabel}</span>
          <span className={styles.editorValue}>
            {editor ? <><Avatar user={editor} size={20} /> {editor.name}</> : COPY.editorNone}
          </span>
        </button>
      </div>

      {selectionError ? <p className={styles.selectionError} role="alert">{selectionError}</p> : null}
      <SaveHint state={saveState} />

      {sheet('status', COPY.statusHeading, (
        <ul className={styles.options}>
          {STATUS_ORDER.map((value) => (
            <li key={value}>
              <button
                type="button"
                className={styles.option}
                aria-pressed={value === status}
                onClick={() => props.onSelectStatus(value)}
              >
                <span>{STATUS_LABELS[value]}</span>
                {value === status ? <CheckIcon aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ))}

      {sheet('priority', COPY.priorityHeading, (
        <ul className={styles.options}>
          {PRIORITY_ORDER.map((value) => (
            <li key={value}>
              <button
                type="button"
                className={styles.option}
                data-priority={value}
                aria-pressed={value === priority}
                onClick={() => props.onSelectPriority(value)}
              >
                <span>{PRIORITY_LABELS[value]}</span>
                {value === priority ? <CheckIcon aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ))}

      {sheet('editor', COPY.editorHeading, (
        <ul className={styles.options}>
          {editorOptions.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                className={styles.option}
                aria-pressed={editor?.id === option.id}
                onClick={() => props.onSelectEditor(option.id)}
              >
                <span className={styles.editorValue}><Avatar user={option} size={20} /> {option.name}</span>
                {editor?.id === option.id ? <CheckIcon aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
          {/* Editor may legitimately be null; `Brak` is the quieter final option. */}
          <li>
            <button
              type="button"
              className={styles.optionQuiet}
              aria-pressed={editor === null}
              onClick={() => props.onSelectEditor(null)}
            >
              <span>{COPY.editorNone}</span>
              {editor === null ? <CheckIcon aria-hidden="true" /> : null}
            </button>
          </li>
        </ul>
      ))}
    </div>
  );
}

// ── ŹRÓDŁA / WEJŚCIE (sec. 5) ──────────────────────────────────────────────

/**
 * The original captured material, kept separate from script, hooks and evidence.
 * Only subsections with content are shown. `NOTATKA DO WEJŚCIA` is the one mutable
 * field here and is not part of `originalInput`.
 */
export function SourcesSection(props: SourcesSectionProps) {
  const {
    expanded, onToggle, summary, originalUrl, originalText, additionalText,
    attachments, onOpenAttachment, inputNote, onChangeInputNote,
    inputNoteSaveState, inputNoteConflict, onOpenSource,
  } = props;

  return (
    <section className={styles.section}>
      <SectionHeader heading={COPY.sourcesHeading} summary={summary ?? undefined} expanded={expanded} onToggle={onToggle} />
      {expanded ? (
        <div className={styles.sectionBody}>
          {originalUrl || originalText ? (
            <div className={styles.subsection}>
              <h3 className={styles.subheading}>{COPY.originalInputHeading}</h3>
              {originalUrl ? (
                <div className={styles.sourceRow}>
                  <span className={styles.microLabel}>{COPY.originalLinkLabel}</span>
                  <span className={styles.sourceValue}>{originalUrl}</span>
                  <TextAction onClick={onOpenSource}>
                    {COPY.openSource} <ExternalLinkIcon aria-hidden="true" />
                  </TextAction>
                </div>
              ) : null}
              {originalText ? (
                <div className={styles.sourceRow}>
                  <span className={styles.microLabel}>{COPY.originalTextLabel}</span>
                  <p className={styles.sourceText}>{originalText}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {additionalText ? (
            <div className={styles.subsection}>
              <h3 className={styles.subheading}>{COPY.additionalTextHeading}</h3>
              <p className={styles.sourceText}>{additionalText}</p>
            </div>
          ) : null}

          {attachments.length > 0 ? (
            <div className={styles.subsection}>
              <h3 className={styles.subheading}>{COPY.attachmentsHeading}</h3>
              <ul className={styles.attachments}>
                {attachments.map((attachment) => (
                  <li key={attachment.id} className={styles.attachmentRow}>
                    {attachment.thumbnailUrl
                      ? <img className={styles.thumb} src={attachment.thumbnailUrl} alt="" />
                      : <span className={styles.thumbPlaceholder} aria-hidden="true" />}
                    <span className={styles.attachmentName}>{attachment.fileName}</span>
                    {/* Preserved but never presented as a successful upload. */}
                    {attachment.unsupported
                      ? <span className={styles.unsupported}>Nieobsługiwany plik</span>
                      : <TextAction onClick={() => onOpenAttachment(attachment.id)}>Otwórz</TextAction>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={styles.subsection}>
            <h3 className={styles.subheading}>{COPY.inputNoteHeading}</h3>
            <textarea
              className={styles.noteField}
              aria-label={COPY.inputNoteHeading}
              value={inputNote}
              rows={3}
              onChange={(event) => onChangeInputNote(event.target.value)}
            />
            <SaveHint state={inputNoteSaveState} />
            {inputNoteConflict ? <ConflictNotice conflict={inputNoteConflict} /> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── UWAGI DO MONTAŻU (sec. 6) ──────────────────────────────────────────────

/** One shared plain-text production note. No threads, no per-user notes. */
export function EditingNotesSection(props: EditingNotesSectionProps) {
  const { expanded, onToggle, summary, value, onChange, saveState, conflict } = props;
  return (
    <section className={styles.section}>
      <SectionHeader heading={COPY.editingNotesHeading} summary={summary} expanded={expanded} onToggle={onToggle} />
      {expanded ? (
        <div className={styles.sectionBody}>
          <textarea
            className={styles.noteField}
            aria-label={COPY.editingNotesHeading}
            value={value}
            rows={5}
            onChange={(event) => onChange(event.target.value)}
          />
          <SaveHint state={saveState} />
          {conflict ? <ConflictNotice conflict={conflict} /> : null}
        </div>
      ) : null}
    </section>
  );
}

// ── MATERIAŁY (sec. 2) ─────────────────────────────────────────────────────

function VerificationRow(
  { verification, onMarkVerified }: Pick<MaterialsSectionProps, 'verification' | 'onMarkVerified'>,
) {
  // Rendered only when a current export exists.
  if (verification.kind === 'no_export') return null;
  return (
    <div className={styles.subsection}>
      <h3 className={styles.subheading}>{COPY.verificationHeading}</h3>
      {verification.kind === 'needs_editor' ? (
        <p className={styles.quiet}>{COPY.verificationNeedsEditor}</p>
      ) : null}
      {verification.kind === 'awaiting_peer' ? (
        <p className={styles.quiet}>{awaitingVerifierLabel(verification.peerName)}</p>
      ) : null}
      {verification.kind === 'unverified_by_me' ? (
        <div className={styles.sourceRow}>
          <span className={styles.quiet}>{COPY.verificationUnverified}</span>
          <TextAction onClick={onMarkVerified}>{COPY.verificationMarkVerified}</TextAction>
        </div>
      ) : null}
      {verification.kind === 'verified' ? (
        <p className={styles.verified}>{verifiedByLabel(verification.verifierName)}</p>
      ) : null}
      {verification.kind === 'outdated' ? (
        <div className={styles.outdated}>
          <span>{COPY.verificationOutdated}</span>
          <p className={styles.quiet}>{previousExportVerifiedBy(verification.previousVerifierName)}</p>
          {verification.canVerifyNewRevision ? (
            <TextAction onClick={onMarkVerified}>{COPY.verificationMarkNewVerified}</TextAction>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** FOLDER kDrive → AKTUALNY EKSPORT → WERYFIKACJA, in exactly that order. */
export function MaterialsSection(props: MaterialsSectionProps) {
  const {
    expanded, onToggle, summary, kdriveFolder, kdriveEnabled, currentExport,
    onCreateKdriveFolder, onOpenKdriveFolder, onRelinkKdriveFolder,
    onOpenExport, onReplaceExport, verification, onMarkVerified, saveState,
  } = props;

  return (
    <section className={styles.section}>
      <SectionHeader heading={COPY.materialsHeading} summary={summary} expanded={expanded} onToggle={onToggle} />
      {expanded ? (
        <div className={styles.sectionBody}>
          <div className={styles.subsection}>
            <h3 className={styles.subheading}>{COPY.kdriveHeading}</h3>
            {kdriveFolder.name === null ? (
              <div className={styles.sourceRow}>
                <span className={styles.quiet}>{COPY.kdriveMissing}</span>
                {/* Always an explicit action; never created during capture or a status change. */}
                <TextAction onClick={onCreateKdriveFolder} disabled={!kdriveEnabled}>
                  {COPY.kdriveCreate}
                </TextAction>
              </div>
            ) : (
              <div className={styles.sourceRow}>
                <span className={styles.sourceValue}>{kdriveFolder.name}</span>
                {kdriveFolder.unavailable ? (
                  <>
                    <span className={styles.unsupported}>Folder niedostępny</span>
                    {/* The stored reference is preserved; relinking is explicit. */}
                    <TextAction onClick={onRelinkKdriveFolder} disabled={!kdriveEnabled}>Połącz ponownie</TextAction>
                  </>
                ) : (
                  <TextAction onClick={onOpenKdriveFolder} disabled={!kdriveEnabled}>
                    {COPY.kdriveOpen} <ExternalLinkIcon aria-hidden="true" />
                  </TextAction>
                )}
              </div>
            )}
            {!kdriveEnabled ? <p className={styles.quiet}>Integracja kDrive nie jest jeszcze dostępna.</p> : null}
          </div>

          <div className={styles.subsection}>
            <h3 className={styles.subheading}>{COPY.exportHeading}</h3>
            {currentExport.label === null ? (
              <p className={styles.quiet}>{COPY.exportMissing}</p>
            ) : (
              <div className={styles.sourceRow}>
                <span className={styles.sourceValue}>{currentExport.label}</span>
                <TextAction onClick={onOpenExport}>
                  Otwórz <ExternalLinkIcon aria-hidden="true" />
                </TextAction>
                {/* Every explicit replacement makes a new revision, same file or not. */}
                <TextAction onClick={onReplaceExport}>{currentExport.label ? COPY.exportReplace : 'Dodaj eksport'}</TextAction>
              </div>
            )}
          </div>

          <VerificationRow verification={verification} onMarkVerified={onMarkVerified} />
          <SaveHint state={saveState} />
        </div>
      ) : null}
    </section>
  );
}

// ── Overflow / delete (sec. 7) ─────────────────────────────────────────────

/** Only `Usuń rolkę`. Confirmation uses the frozen copy and exact button labels. */
export function ReelOverflow(props: ReelOverflowProps) {
  const { open, onOpen, onDismiss, onRequestDelete, confirmingDelete, onCancelDelete, onConfirmDelete, deleteState } = props;
  return (
    <>
      <button type="button" className={styles.overflowTrigger} onClick={onOpen} aria-label="Więcej">⋮</button>
      {open && !confirmingDelete ? (
        <div className={styles.sheetBackdrop} onClick={onDismiss} role="presentation">
          <div className={styles.sheet} role="menu" onClick={(event) => event.stopPropagation()}>
            <button type="button" className={styles.option} role="menuitem" onClick={onRequestDelete}>
              {COPY.deleteReel}
            </button>
          </div>
        </div>
      ) : null}
      {confirmingDelete ? (
        <div className={styles.sheetBackdrop} role="presentation">
          {/* A T06-owned dialog, so the exact Anuluj/Usuń labels hold on every platform. */}
          <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={COPY.deleteConfirmTitle}>
            <h2 className={styles.sheetHeading}>{COPY.deleteConfirmTitle}</h2>
            <p className={styles.quiet}>{COPY.deleteConfirmBody}</p>
            <div className={styles.confirmActions}>
              <TextAction onClick={onCancelDelete}>{COPY.deleteCancel}</TextAction>
              <TextAction onClick={onConfirmDelete}>{COPY.deleteConfirm}</TextAction>
            </div>
            <SaveHint state={deleteState} />
          </div>
        </div>
      ) : null}
    </>
  );
}

/** `Przywróć rolkę`, shown when an opened Reel is soft-deleted (sec. 8). */
export function RestoreBanner({ onRestore, saveState }: RestoreBannerProps) {
  return (
    <div className={styles.restore} role="status">
      <span className={styles.quiet}>Ta rolka jest usunięta.</span>
      <TextAction onClick={onRestore}>{COPY.restoreReel}</TextAction>
      <SaveHint state={saveState} />
    </div>
  );
}

export type { Id };
