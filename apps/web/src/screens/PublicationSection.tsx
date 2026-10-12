import '../ui/tokens.css';
import { COPY, type PublicationSectionProps } from '../ui/screen-contracts.js';
import { ActionButton, CoverIndicator, TextAction } from '../ui/primitives.js';
import { CalendarIcon, CheckIcon, ExternalLinkIcon } from '../ui/icons.js';
import { publicationEmphasis } from '../data/detail-actions.js';
import styles from './PublicationSection.module.css';

/**
 * Expanded inline Reel Detail section (frozen-visual-spec.md sec. 6) — never a
 * separate large screen. Rendered by ReelDetailScreen when its PUBLIKACJA row
 * is toggled open, and exported standalone for isolated development/testing.
 */
export function PublicationSection(props: PublicationSectionProps) {
  const {
    feedCoverDone, hasFeedCoverAsset, onToggleFeedCoverDone, onAddOrChangeFeedCoverAsset, onOpenFeedCoverAsset,
    kdriveEnabled = true, createFolderForCover = false, uploadJob, onCancelUpload, onRetryUpload,
    description, onChangeDescription,
    source, sourceManual, sourceAutomaticAvailable, sourceMetadataState, sourceLongWait, sourceUndoAvailable,
    onAddArticleLink,
    onChangeSource, onRefreshSource, onRestoreAutomaticSource, onUndoRestoreSource, onCheckSource,
    hashtags, onChangeHashtags,
    onCopyDescription, onGeneratePublication, generatePublicationEnabled, generatePublicationHint, plan, isPublished, isReady,
    publishedAt, publicationLinks, onAddPublicationLink, onOpenPublicationLink,
    streamSourceLines,
  } = props;
  // UI-02 F: generation leads while there is no description; copying leads once there is copy.
  const emphasis = publicationEmphasis(description, hashtags);

  return (
    <div className={styles.section}>
      {isPublished ? <p className={styles.publishedSummary}>
        {description.trim() || hashtags.trim()
          ? [description.trim().slice(0, 120), hashtags.trim().slice(0, 60)].filter(Boolean).join(' · ')
          : 'Opublikowano · brak opisu i hashtagów'}
      </p> : null}
      <div className={styles.block}>
        <span className={styles.label}>Okładka do feedu</span>
        {isReady && !feedCoverDone ? <p className={styles.coverWarning}>Okładka niegotowa. {COPY.feedCoverRequired}</p> : null}
        <div className={styles.coverRow}>
          <button type="button" className={styles.coverToggle} data-feed-cover-toggle onClick={onToggleFeedCoverDone}>
            <CoverIndicator done={feedCoverDone} size={22} />
            <span>{feedCoverDone ? 'Gotowa' : 'Nie gotowa'}</span>
          </button>
          <div className={styles.coverActions}>
            <TextAction onClick={onAddOrChangeFeedCoverAsset} disabled={!kdriveEnabled}>
              {createFolderForCover ? 'Utwórz folder i wgraj' : hasFeedCoverAsset ? 'Zmień' : '+ Dodaj'}
            </TextAction>
            {hasFeedCoverAsset ? <TextAction onClick={onOpenFeedCoverAsset}>Otwórz</TextAction> : null}
          </div>
        </div>
        {uploadJob?.purpose === 'cover' ? <div className={styles.uploadStatus} aria-live="polite">
          <span>{uploadJob.fileName}</span>
          {uploadJob.phase === 'error' ? <span role="status">{uploadJob.error}</span> : <>
            <span>{uploadJob.phase === 'uploading' ? `${(uploadJob.completedBytes / 1048576).toFixed(1)} z ${(uploadJob.totalBytes / 1048576).toFixed(1)} MB` : uploadJob.phase === 'finishing' ? 'Kończenie wysyłania…' : uploadJob.phase === 'attaching' ? 'Dołączanie okładki…' : 'Wysłano'}</span>
            <progress value={uploadJob.percent} max={100} aria-label="Postęp wysyłania okładki" />
          </>}
          {uploadJob.phase === 'error' && onRetryUpload ? <TextAction onClick={onRetryUpload}>Ponów</TextAction> : null}
          {['uploading', 'finishing', 'attaching', 'error'].includes(uploadJob.phase) && onCancelUpload ? <TextAction onClick={onCancelUpload}>Anuluj</TextAction> : null}
        </div> : null}
        {feedCoverDone && uploadJob?.phase === 'done' && uploadJob.purpose === 'cover' ? <p className={styles.prerequisite}>Okładka wgrana i oznaczona jako gotowa.</p> : null}
      </div>

      {plan ? <button type="button" className={styles.planRow} onClick={plan.onOpen} data-planned={plan.label ? 'true' : undefined}>
        <CalendarIcon />
        {plan.label ? <span>Termin: <strong>{plan.label}</strong> · Zmień termin</span> : <span>Zaplanuj</span>}
      </button> : null}

      {/* D3: no `Wygeneruj opis` on a stream — `streamSourceLines` presence implies format 'stream'. */}
      {onGeneratePublication && !isPublished && !streamSourceLines ? <div className={styles.generateRow} data-emphasis={emphasis.generate}>
        <ActionButton tone={emphasis.generate} onClick={onGeneratePublication} disabled={!generatePublicationEnabled}>
          {emphasis.generate === 'primary' ? 'Wygeneruj opis' : 'Wygeneruj nowy opis'}
        </ActionButton>
        {generatePublicationHint ? <p className={styles.prerequisite}>{generatePublicationHint}</p> : null}
      </div> : null}

      <div className={styles.block}>
        <span className={styles.labelRow}>
          <span className={styles.label}>Opis</span>
          {/* Ready, quietly: a small check and word, not a banner. */}
          {emphasis.ready ? <span className={styles.readyMark}><CheckIcon size={12} aria-hidden="true" /> gotowy</span> : null}
        </span>
        <textarea
          className={styles.textField}
          aria-label="Opis publikacji"
          value={description}
          onChange={(event) => onChangeDescription(event.target.value)}
        />
      </div>

      {streamSourceLines ? (
        /* D7: a stream's ŹRÓDŁA — read-only, one line per topic, in topic order; each is edited
           on its own topic (absorbed) or Rolka (linked), never here. */
        <div className={styles.block}>
          <span className={styles.label}>Źródła</span>
          {streamSourceLines.length > 0 ? (
            <ul className={styles.textField} aria-label="Źródła" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {streamSourceLines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
            </ul>
          ) : null}
          <div className={styles.sourceMeta}><span>Źródła z tematów</span></div>
        </div>
      ) : (
        <div className={styles.block}>
          <span className={styles.label}>Źródło</span>
          <textarea className={styles.textField} aria-label="Źródło" value={source} onChange={(event) => onChangeSource(event.target.value)} />
          <div className={styles.sourceMeta}>
            <span>{sourceUndoAvailable ? 'Przywrócono automatyczne źródło.' : sourceManual ? 'Wpisane ręcznie' : sourceMetadataState === 'pending' ? sourceLongWait ? 'Pobieranie trwa dłużej niż zwykle.' : 'Pobieranie danych źródła…' : sourceMetadataState === 'found' ? 'Automatycznie z linku' : sourceMetadataState === 'partial' ? 'Automatycznie z adresu strony' : sourceMetadataState === 'failed' ? 'Nie udało się pobrać danych źródła.' : sourceMetadataState === 'blocked' ? 'Strona blokuje automatyczne pobieranie. Wpisz autora ręcznie.' : sourceMetadataState === 'unsupported' ? 'Tego linku nie da się odczytać automatycznie. Wpisz źródło ręcznie.' : sourceMetadataState === 'no_url' ? 'Brak linku w materiale.' : 'Pobierz dane źródła z linku.'}</span>
            {sourceUndoAvailable ? <TextAction onClick={onUndoRestoreSource}>Cofnij</TextAction>
              : sourceManual ? sourceAutomaticAvailable ? <TextAction onClick={onRestoreAutomaticSource}>Przywróć automatyczne</TextAction> : null
                : sourceMetadataState === 'pending' ? sourceLongWait ? <TextAction onClick={onCheckSource}>Sprawdź</TextAction> : null
                  : sourceMetadataState === 'no_url' ? <TextAction onClick={onAddArticleLink}>Dodaj link</TextAction>
                    : sourceMetadataState === 'blocked' || sourceMetadataState === 'unsupported' ? null
                    : sourceMetadataState === 'failed' ? <TextAction onClick={onRefreshSource}>Ponów</TextAction>
                      : sourceMetadataState === 'never' || sourceMetadataState === null ? <TextAction onClick={onRefreshSource}>Pobierz</TextAction>
                        : <TextAction onClick={onRefreshSource}>Odśwież</TextAction>}
          </div>
        </div>
      )}

      <div className={styles.block}>
        <span className={styles.label}>Hashtagi</span>
        <textarea
          className={styles.textField}
          aria-label="Hashtagi"
          value={hashtags}
          onChange={(event) => onChangeHashtags(event.target.value)}
        />
      </div>

      <ActionButton className={styles.copyAction} tone={emphasis.copy === 'primary' ? 'primary' : 'quiet'} onClick={onCopyDescription}>
        Kopiuj opis
      </ActionButton>
      {isPublished || publishedAt || publicationLinks.length ? <div className={styles.block}>
        <span className={styles.label}>Po publikacji</span>
        <div className={styles.postPublication}>
          {publishedAt ? <span className={styles.publishedAt}>{publishedAt}</span> : null}
          {publicationLinks.map((link) => (
            <button
              key={link.id}
              type="button"
              className={styles.link}
              onClick={() => onOpenPublicationLink(link.id)}
            >
              <span className={styles.linkUrl}>{link.url}</span>
              <ExternalLinkIcon />
            </button>
          ))}
          <TextAction onClick={onAddPublicationLink}>+ Dodaj link</TextAction>
        </div>
      </div> : null}
    </div>
  );
}
