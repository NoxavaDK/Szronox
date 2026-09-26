import '../ui/tokens.css';
import { COPY, type PublicationSectionProps } from '../ui/screen-contracts.js';
import { CoverIndicator, TextAction } from '../ui/primitives.js';
import { CalendarIcon, ExternalLinkIcon } from '../ui/icons.js';
import styles from './PublicationSection.module.css';

/**
 * Expanded inline Reel Detail section (frozen-visual-spec.md sec. 6) — never a
 * separate large screen. Rendered by ReelDetailScreen when its PUBLIKACJA row
 * is toggled open, and exported standalone for isolated development/testing.
 */
export function PublicationSection(props: PublicationSectionProps) {
  const {
    feedCoverDone, hasFeedCoverAsset, onToggleFeedCoverDone, onAddOrChangeFeedCoverAsset, onOpenFeedCoverAsset,
    description, onChangeDescription,
    hashtags, onChangeHashtags,
    onCopyDescription, onGeneratePublication, generatePublicationEnabled, generatePublicationHint, plan, isPublished, isReady,
    publishedAt, publicationLinks, onAddPublicationLink, onOpenPublicationLink,
  } = props;

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
            <TextAction onClick={onAddOrChangeFeedCoverAsset}>
              {hasFeedCoverAsset ? 'Zmień' : '+ Dodaj'}
            </TextAction>
            {hasFeedCoverAsset ? <TextAction onClick={onOpenFeedCoverAsset}>Otwórz</TextAction> : null}
          </div>
        </div>
      </div>

      {plan ? <button type="button" className={styles.planRow} onClick={plan.onOpen} data-planned={plan.label ? 'true' : undefined}>
        <CalendarIcon />
        {plan.label ? <span>Termin: <strong>{plan.label}</strong> · Zmień termin</span> : <span>Zaplanuj</span>}
      </button> : null}

      {onGeneratePublication ? <div className={styles.generateRow}>
        <TextAction onClick={onGeneratePublication} disabled={!generatePublicationEnabled}>Wygeneruj opis</TextAction>
        {generatePublicationHint ? <p className={styles.prerequisite}>{generatePublicationHint}</p> : null}
      </div> : null}

      <div className={styles.block}>
        <span className={styles.label}>Opis</span>
        <textarea
          className={styles.textField}
          aria-label="Opis publikacji"
          value={description}
          onChange={(event) => onChangeDescription(event.target.value)}
        />
      </div>

      <div className={styles.block}>
        <span className={styles.label}>Hashtagi</span>
        <textarea
          className={styles.textField}
          aria-label="Hashtagi"
          value={hashtags}
          onChange={(event) => onChangeHashtags(event.target.value)}
        />
      </div>

      <TextAction className={styles.copyAction} onClick={onCopyDescription}>Kopiuj opis</TextAction>
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
