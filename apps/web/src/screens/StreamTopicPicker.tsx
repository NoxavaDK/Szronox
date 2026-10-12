import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Reel, StreamTopicCandidate } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { polishError } from '../data/errors.js';
import { groupStreamCandidates, isDirectLinkCandidate, topicLabel } from '../data/streams.js';
import { reelLabel } from '../data/reel-label.js';
import { STATUS_LABELS } from '../ui/screen-contracts.js';

/** `topicLabel`'s fallback is `reelLabel`'s script/capture-derived text (see `data/streams.ts`). */
function candidateLabel(candidate: StreamTopicCandidate): string {
  const fallback = reelLabel({ title: '', originalInput: candidate.originalInput, script: candidate.script }).text;
  return topicLabel({ title: candidate.title, selectedHookText: candidate.selectedHookText }, fallback);
}
import { TextAction } from '../ui/primitives.js';
import { CloseIcon } from '../ui/icons.js';
import styles from './StreamTopicPicker.module.css';

const STATUS_GROUP_LABEL: Record<string, string> = { to_record: 'Do nagrania', editing: 'Montaż', ready: 'Gotowe', published: 'Opublikowane' };

/**
 * `Dodaj temat` — STREAM-01 D5. A full-height sheet searching `GET .../topic-candidates`.
 * Rendered by `StreamTopics`, which already owns the API client and the stream Reel.
 */
export function StreamTopicPicker({ api, stream, onClose, onAdded }: {
  api: CoreApiClient;
  stream: Reel;
  onClose: () => void;
  onAdded: (reel: Reel, addedTopicId?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<StreamTopicCandidate[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setLoadState('loading');
    const timer = window.setTimeout(() => {
      void api.streamTopicCandidates(stream.id, query.trim()).then((response) => {
        if (requestId.current !== id) return;
        setItems(response.items);
        setLoadState('loaded');
      }).catch(() => { if (requestId.current === id) setLoadState('error'); });
    }, query.trim() === '' ? 0 : 250);
    return () => window.clearTimeout(timer);
  }, [api, stream.id, query]);

  useEffect(() => { sheetRef.current?.querySelector<HTMLElement>('input')?.focus(); }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  };

  const addLink = async (candidate: StreamTopicCandidate) => {
    setBusyId(candidate.id);
    setError(null);
    try {
      const updated = await api.addStreamTopic(stream.id, { operationId: crypto.randomUUID(), expectedVersion: stream.version, mode: 'link', reelId: candidate.id });
      onAdded(updated);
    } catch (err) {
      setError(polishError(err));
    } finally {
      setBusyId(null);
    }
  };

  const absorb = async (candidate: StreamTopicCandidate) => {
    setBusyId(candidate.id);
    setError(null);
    try {
      const updated = await api.addStreamTopic(stream.id, { operationId: crypto.randomUUID(), expectedVersion: stream.version, mode: 'absorb', reelId: candidate.id });
      const addedTopic = updated.topics.find((topic) => topic.source.reelId === candidate.id);
      onAdded(updated, addedTopic?.id);
    } catch (err) {
      setError(polishError(err));
    } finally {
      setBusyId(null);
    }
  };

  const grouped = groupStreamCandidates(items);

  const row = (candidate: StreamTopicCandidate) => {
    const label = candidateLabel(candidate);
    const disabled = candidate.inThisStream;
    const expanded = expandedId === candidate.id;
    return (
      <li key={candidate.id} className={styles.row}>
        <button
          type="button"
          className={styles.rowMain}
          disabled={disabled || busyId !== null}
          onClick={() => {
            if (isDirectLinkCandidate(candidate.status)) void addLink(candidate);
            else setExpandedId((old) => (old === candidate.id ? null : candidate.id));
          }}
        >
          <span className={styles.rowTitle}>{label}</span>
          <span className={styles.rowStatus}>
            {disabled ? 'W tym streamie' : candidate.status === 'idea' ? 'Pomysł' : STATUS_GROUP_LABEL[candidate.status] ?? STATUS_LABELS[candidate.status]}
            {candidate.plannedPublicationDate ? ` · ${candidate.plannedPublicationDate}` : ''}
          </span>
        </button>
        {expanded && !disabled ? (
          <div className={styles.expanded}>
            <div className={styles.choice}>
              <TextAction onClick={() => void absorb(candidate)} disabled={busyId !== null}>Przenieś do streamu</TextAction>
              <span className={styles.choiceNote}>Pomysł zniknie z listy. Możesz go później odłączyć.</span>
            </div>
            <div className={styles.choice}>
              <TextAction onClick={() => void addLink(candidate)} tone="quiet" disabled={busyId !== null}>Dodaj odwołanie</TextAction>
              <span className={styles.choiceNote}>Pomysł pozostanie na liście.</span>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div ref={sheetRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label="Dodaj temat" onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <header className={styles.header}>
          <h2 className={styles.heading}>Dodaj temat</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Zamknij"><CloseIcon /></button>
        </header>
        <input className={styles.search} type="search" placeholder="Szukaj…" aria-label="Szukaj tematu" value={query} onChange={(event) => setQuery(event.target.value)} />

        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {loadState === 'loading' && items.length === 0 ? <p className={styles.quiet}>Wyszukiwanie…</p> : null}
        {loadState === 'error' ? <p className={styles.error} role="alert">Nie udało się wczytać wyników.</p> : null}
        {loadState === 'loaded' && items.length === 0 ? <p className={styles.quiet}>Brak wyników.</p> : null}

        {grouped.rolki.length > 0 ? (
          <div className={styles.group}>
            <h3 className={styles.groupLabel}>ROLKI</h3>
            {grouped.rolki.map((bucket) => (
              <ul className={styles.list} key={bucket.status}>{bucket.items.map(row)}</ul>
            ))}
          </div>
        ) : null}
        {grouped.pomysly.length > 0 ? (
          <div className={styles.group}>
            <h3 className={styles.groupLabel}>POMYSŁY</h3>
            <ul className={styles.list}>{grouped.pomysly.map(row)}</ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
