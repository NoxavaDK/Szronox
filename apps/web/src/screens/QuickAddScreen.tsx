import { useState } from 'react';
import '../ui/tokens.css';
import type { CaptureKind, QuickAddScreenProps } from '../ui/screen-contracts.js';
import { Button, CompactTabs, PrioritySelector, TextAction } from '../ui/primitives.js';
import { BackArrowIcon, CloseIcon } from '../ui/icons.js';
import styles from './QuickAddScreen.module.css';

const KIND_OPTIONS: Array<{ value: CaptureKind; label: string }> = [
  { value: 'image', label: 'Zdjęcie' },
  { value: 'url', label: 'Link' },
  { value: 'text', label: 'Tekst' },
];

const KIND_LABEL: Record<CaptureKind, string> = { image: 'Zdjęcie', url: 'Link', text: 'Tekst' };

/** "Nowy pomysł" — frozen-visual-spec.md sec. 3. Controlled: all state and intents come from props. */
const FORMAT_OPTIONS: Array<{ value: 'reel' | 'stream'; label: string }> = [
  { value: 'reel', label: 'ROLKA' },
  { value: 'stream', label: 'STREAM' },
];

export function QuickAddScreen(props: QuickAddScreenProps) {
  const {
    onBack, detectedKind, selectedKind, onChangeKind,
    url, onChangeUrl, images, onAddImage, onRemoveImage,
    text, onChangeText,
    textMode, onChangeTextMode,
    showAccompanyingText, onRevealAccompanyingText, accompanyingText, onChangeAccompanyingText,
    showHookField, onRevealHookField, initialHook, onChangeInitialHook,
    priority, onChangePriority,
    canSave, onSave, onOpracuj, saveState,
    format, onChangeFormat, streamTitle, onChangeStreamTitle,
  } = props;

  // Detected-share payloads start collapsed to a compact chip (sec. 3); "Zmień" reveals
  // the full selector. Purely presentational — it does not affect the selected kind.
  const [selectorRevealed, setSelectorRevealed] = useState(detectedKind === null);
  // D2: STREAM has no AI entry point — hide `✦ Opracuj` and `+ Hook` for it.
  const isStream = format === 'stream';

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <button type="button" className={styles.backButton} onClick={onBack} aria-label="Wstecz">
          <BackArrowIcon />
        </button>
        <h1 className={styles.title}>{isStream ? 'Nowy stream' : 'Nowy pomysł'}</h1>
      </header>

      {/* D2: compact ROLKA | STREAM selector, above the capture-type tabs. Absent entirely
          when the host has not wired stream creation yet. */}
      {onChangeFormat ? (
        <CompactTabs label="Format" options={FORMAT_OPTIONS} value={format ?? 'reel'} onChange={onChangeFormat} />
      ) : null}

      {isStream ? (
        <div className={styles.section}>
          <span className={styles.sectionLabel}>Tytuł streamu</span>
          <input
            className={styles.urlField}
            type="text"
            aria-label="Tytuł streamu"
            value={streamTitle ?? ''}
            onChange={(event) => onChangeStreamTitle?.(event.target.value)}
          />
        </div>
      ) : null}

      {detectedKind !== null && !selectorRevealed ? (
        <div className={styles.detectedChip}>
          <span>{KIND_LABEL[detectedKind]}</span>
          <TextAction onClick={() => setSelectorRevealed(true)}>Zmień</TextAction>
        </div>
      ) : (
        <CompactTabs label="Typ" options={KIND_OPTIONS} value={selectedKind} onChange={onChangeKind} />
      )}

      {selectedKind === 'url' ? (
        <div className={styles.section}>
          <input
            className={styles.urlField}
            type="url"
            inputMode="url"
            placeholder="Wklej link"
            aria-label="Link"
            value={url}
            onChange={(event) => onChangeUrl(event.target.value)}
          />
        </div>
      ) : null}

      {selectedKind === 'image' ? (
        <div className={styles.section}>
          <div className={styles.imageList}>
            {images.map((image) => (
              <div className={styles.imageTile} key={image.id}>
                {image.previewUrl ? (
                  <img className={styles.imageThumb} src={image.previewUrl} alt="" />
                ) : (
                  <div className={styles.imageThumbPlaceholder} aria-hidden>
                    …
                  </div>
                )}
                <div className={styles.imageMeta}>
                  <span className={styles.imageFileName}>{image.fileName}</span>
                  <button
                    type="button"
                    className={styles.imageRemove}
                    onClick={() => onRemoveImage(image.id)}
                    aria-label={`Usuń ${image.fileName}`}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <TextAction onClick={onAddImage}>+ Dodaj zdjęcie</TextAction>
        </div>
      ) : null}

      {selectedKind === 'text' ? (
        <div className={styles.section}>
          <CompactTabs
            label="Znaczenie tekstu"
            options={[{ value: 'idea', label: 'Pomysł' }, { value: 'script', label: 'Gotowy skrypt' }]}
            value={textMode}
            onChange={onChangeTextMode}
          />
          <textarea
            className={styles.textField}
            aria-label={textMode === 'script' ? 'Gotowy skrypt' : 'Pomysł'}
            placeholder="Wpisz treść"
            value={text}
            onChange={(event) => onChangeText(event.target.value)}
          />
        </div>
      ) : null}

      <div className={styles.optionalActions}>
        {selectedKind !== 'text' && !showAccompanyingText ? (
          <TextAction onClick={onRevealAccompanyingText}>+ Dodaj tekst</TextAction>
        ) : null}
        {/* D2/D3: no AI entry point (and so no `+ Hook`) for a stream. */}
        {!isStream && !showHookField ? <TextAction onClick={onRevealHookField}>+ Hook</TextAction> : null}
      </div>

      {selectedKind !== 'text' && showAccompanyingText ? (
        <div className={styles.section}>
          <span className={styles.sectionLabel}>Tekst</span>
          <textarea
            className={styles.textField}
            aria-label="Dodatkowy tekst"
            value={accompanyingText}
            onChange={(event) => onChangeAccompanyingText(event.target.value)}
          />
        </div>
      ) : null}

      {!isStream && showHookField ? (
        <div className={styles.section}>
          <span className={styles.sectionLabel}>Hook</span>
          <input
            className={styles.urlField}
            type="text"
            aria-label="Hook"
            value={initialHook}
            onChange={(event) => onChangeInitialHook(event.target.value)}
          />
        </div>
      ) : null}

      <PrioritySelector value={priority} onChange={onChangePriority} />

      <div className={styles.actions}>
        <Button onClick={onSave} disabled={!canSave} fullWidth>
          ZAPISZ
        </Button>
        {/* D2: ZAPISZ is the only bottom action for a stream — no Opracuj. */}
        {!isStream ? (
          <TextAction onClick={onOpracuj} tone="quiet">
            ✦ Opracuj
          </TextAction>
        ) : null}
        <AutosaveMessage state={saveState} />
      </div>
    </div>
  );
}

function AutosaveMessage({ state }: { state: QuickAddScreenProps['saveState'] }) {
  if (state === 'saved') {
    return <p className={styles.autosave}>Szkic zapisany</p>;
  }
  if (state === 'offline') {
    return (
      <p className={styles.autosave} data-tone="offline">
        Brak sieci · zapisano lokalnie
      </p>
    );
  }
  if (state === 'error') {
    return (
      <p className={styles.autosave} data-tone="error">
        Nie zapisano lokalnie
      </p>
    );
  }
  return null;
}
