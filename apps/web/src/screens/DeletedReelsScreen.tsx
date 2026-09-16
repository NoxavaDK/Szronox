import '../ui/tokens.css';
import type { DeletedReelsScreenProps } from '../ui/screen-contracts.js';
import { COPY } from '../ui/screen-contracts.js';
import { StatusBanner } from '../ui/primitives.js';
import { BackArrowIcon } from '../ui/icons.js';
import styles from './ReelListScreen.module.css';

/**
 * `Usunięte` — frozen Reel Detail batch sec. 8.
 *
 * Reuses the Reel-list visual language deliberately: no new card layout. This is a
 * quiet secondary view reached from the screen-level overflow, never a sixth status
 * and never a primary tab. Restore itself lives on the opened Reel.
 */
export function DeletedReelsScreen({ onBack, loadState, items, onOpenReel, onRetry }: DeletedReelsScreenProps) {
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <button type="button" onClick={onBack} aria-label="Wstecz"><BackArrowIcon /></button>
        <h1 className={styles.title}>{COPY.deletedEntry}</h1>
      </header>

      {loadState === 'loading' ? <StatusBanner tone="loading" message="Wczytywanie…" /> : null}
      {loadState === 'offline' ? <StatusBanner tone="offline" message="Brak połączenia" /> : null}
      {loadState === 'error' ? (
        <StatusBanner tone="error" message="Nie udało się wczytać" actionLabel="Ponów" onAction={onRetry} />
      ) : null}
      {loadState === 'loaded' && items.length === 0 ? (
        <StatusBanner tone="empty" message="Brak usuniętych rolek" />
      ) : null}

      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id} className={styles.row}>
            <button type="button" className={styles.rowMain} onClick={() => onOpenReel(item.id)}>
              <span className={styles.titleLine}>
                {/* Same treatment as the active list: an untitled Reel is labelled from its
                    capture, quietly, rather than rendering an empty row. */}
                <span className={item.titleIsDerived ? `${styles.rowTitle} ${styles.rowTitleDerived}` : styles.rowTitle}>
                  {item.title}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
