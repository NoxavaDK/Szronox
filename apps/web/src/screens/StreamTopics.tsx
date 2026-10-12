import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { Reel, StreamTopic, StreamTopicSource } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { ClientApiError, polishError } from '../data/errors.js';
import { flushTopicBeforeSwitch, topicLabel, type TopicDraftSaveState } from '../data/streams.js';
import { reelLabel, UNTITLED_LABEL } from '../data/reel-label.js';
import { STATUS_LABELS } from '../ui/screen-contracts.js';
import { TextAction } from '../ui/primitives.js';
import { OverflowIcon } from '../ui/icons.js';
import { StreamTopicPicker } from './StreamTopicPicker.js';
import styles from './StreamTopics.module.css';

interface TopicDraft {
  title: string;
  notes: string;
  script: string;
  publicationSource: string | null;
  saveState: TopicDraftSaveState;
  error: string | null;
}

/** `topicLabel`'s fallback is `reelLabel`'s script/capture-derived text, computed here (see `data/streams.ts`). */
function sourceLabel(source: StreamTopicSource): string {
  const fallback = source.originalInput ? reelLabel({ title: '', originalInput: source.originalInput }).text : UNTITLED_LABEL;
  return topicLabel({ title: source.title, selectedHookText: source.selectedHookText }, fallback);
}

function draftFromTopic(topic: StreamTopic): TopicDraft {
  return { title: topic.title, notes: topic.notes, script: topic.script, publicationSource: topic.source.publicationSource, saveState: 'idle', error: null };
}

const SAVE_DEBOUNCE_MS = 700;
const DRAG_TYPE = 'application/x-szronox-topic';

/**
 * TEMATY — STREAM-01 D3/D4/D5 (design/oct-2026-delta-spec.md §D). A self-contained CRUD
 * surface nested one level under a stream Reel: it owns its own API calls directly (the same
 * pragmatic exception `LiveScreen` makes, STREAM-LIVE-01), rather than routing every topic
 * field through the host's single-Reel patch/draft machinery.
 */
export function StreamTopics({ api, stream, onStreamChange, onOpenReel, readOnly = false }: {
  api: CoreApiClient;
  stream: Reel;
  onStreamChange: (reel: Reel) => void;
  onOpenReel?: (id: string) => void;
  readOnly?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TopicDraft>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newTopic, setNewTopic] = useState<{ title: string; link: string; note: string; saving: boolean; error: string | null } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const draggedId = useRef<string | null>(null);
  const timers = useRef<Map<string, number>>(new Map());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const streamRef = useRef(stream);
  streamRef.current = stream;

  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);
  // The expanded topic may have been removed from under us (Odłącz/Usuń odwołanie elsewhere).
  useEffect(() => { if (expandedId !== null && !stream.topics.some((topic) => topic.id === expandedId)) setExpandedId(null); }, [stream.topics, expandedId]);

  const topics = stream.topics;

  const setDraft = (topicId: string, patch: Partial<TopicDraft>) => {
    setDrafts((old) => {
      const topic = topics.find((item) => item.id === topicId);
      const base = old[topicId] ?? (topic ? draftFromTopic(topic) : { title: '', notes: '', script: '', publicationSource: null, saveState: 'idle' as const, error: null });
      return { ...old, [topicId]: { ...base, ...patch } };
    });
  };

  const saveNow = async (topicId: string): Promise<boolean> => {
    const current = draftsRef.current[topicId];
    if (!current) return true;
    const timer = timers.current.get(topicId);
    if (timer !== undefined) { window.clearTimeout(timer); timers.current.delete(topicId); }
    setDraft(topicId, { saveState: 'saving' });
    try {
      const updated = await api.patchStreamTopic(streamRef.current.id, topicId, {
        operationId: crypto.randomUUID(),
        expectedVersion: streamRef.current.version,
        changes: { title: current.title, notes: current.notes, script: current.script, publicationSource: current.publicationSource },
      });
      onStreamChange(updated);
      setDraft(topicId, { saveState: 'saved', error: null });
      return true;
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 409) {
        setDraft(topicId, { saveState: 'conflict', error: 'Ktoś zmienił ten stream w trakcie edycji.' });
      } else {
        setDraft(topicId, { saveState: 'error', error: polishError(error) });
      }
      return false;
    }
  };

  const scheduleSave = (topicId: string) => {
    const timer = timers.current.get(topicId);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.set(topicId, window.setTimeout(() => { void saveNow(topicId); }, SAVE_DEBOUNCE_MS));
  };

  const changeDraftField = (topicId: string, field: 'title' | 'notes' | 'script', value: string) => {
    setDraft(topicId, { [field]: value, saveState: 'dirty', error: null });
    scheduleSave(topicId);
  };

  const changeSource = (topicId: string, value: string, automatic: string | null) => {
    // Typing restores the manual value; an empty field returns to automatic (null), matching §A.
    const trimmed = value;
    setDraft(topicId, { publicationSource: trimmed === (automatic ?? '') ? null : trimmed, saveState: 'dirty', error: null });
    scheduleSave(topicId);
  };

  /** D4: flush-before-switch. A failed/conflicted flush keeps the topic expanded. */
  const requestSwitch = async (next: string | null) => {
    if (expandedId === null || expandedId === next) { setExpandedId(next); return; }
    const expandedTopic = topics.find((topic) => topic.id === expandedId);
    if (!expandedTopic || expandedTopic.kind !== 'absorbed') { setExpandedId(next); return; }
    const state = drafts[expandedId]?.saveState ?? 'idle';
    const ok = await flushTopicBeforeSwitch(state, () => saveNow(expandedId));
    if (ok) setExpandedId(next);
  };

  const discardDraft = (topicId: string) => {
    const topic = topics.find((item) => item.id === topicId);
    if (!topic) return;
    setDrafts((old) => ({ ...old, [topicId]: draftFromTopic(topic) }));
  };

  const reorder = async (topicId: string, direction: 'up' | 'down') => {
    const index = topics.findIndex((topic) => topic.id === topicId);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || target < 0 || target >= topics.length) return;
    const ids = topics.map((topic) => topic.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setRowBusy(topicId);
    setListMessage(null);
    try {
      const updated = await api.reorderStreamTopics(stream.id, { operationId: crypto.randomUUID(), expectedVersion: stream.version, topicIds: ids });
      onStreamChange(updated);
    } catch (error) {
      setListMessage(polishError(error));
    } finally {
      setRowBusy(null);
    }
  };

  const commitDrop = async (targetId: string) => {
    const sourceId = draggedId.current;
    draggedId.current = null;
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = topics.map((topic) => topic.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    setRowBusy(sourceId);
    setListMessage(null);
    try {
      const updated = await api.reorderStreamTopics(stream.id, { operationId: crypto.randomUUID(), expectedVersion: stream.version, topicIds: ids });
      onStreamChange(updated);
    } catch (error) {
      setListMessage(polishError(error));
    } finally {
      setRowBusy(null);
    }
  };

  const removeTopic = async (topic: StreamTopic) => {
    setMenuOpenId(null);
    setRowBusy(topic.id);
    setListMessage(null);
    try {
      const updated = await api.removeStreamTopic(stream.id, topic.id, { operationId: crypto.randomUUID(), expectedVersion: stream.version });
      onStreamChange(updated);
      if (expandedId === topic.id) setExpandedId(null);
      setListMessage(topic.kind === 'absorbed' ? 'Pomysł wrócił do listy' : null);
    } catch (error) {
      setListMessage(polishError(error));
    } finally {
      setRowBusy(null);
    }
  };

  const submitNewTopic = async () => {
    if (!newTopic || newTopic.title.trim() === '') return;
    setNewTopic({ ...newTopic, saving: true, error: null });
    const topicId = crypto.randomUUID();
    const reelId = crypto.randomUUID();
    try {
      const updated = await api.addStreamTopic(stream.id, {
        operationId: crypto.randomUUID(),
        expectedVersion: stream.version,
        mode: 'new',
        topicId,
        reelId,
        title: newTopic.title.trim(),
        ...(newTopic.link.trim() ? { link: newTopic.link.trim() } : {}),
        ...(newTopic.note.trim() ? { note: newTopic.note.trim() } : {}),
      });
      onStreamChange(updated);
      setNewTopic(null);
      setExpandedId(topicId);
    } catch (error) {
      setNewTopic({ ...newTopic, saving: false, error: 'Nie udało się dodać tematu.' });
    }
  };

  const onAdded = (updated: Reel, addedTopicId?: string) => {
    onStreamChange(updated);
    setPickerOpen(false);
    if (addedTopicId) setExpandedId(addedTopicId);
  };

  if (readOnly) {
    return (
      <section className={styles.section} aria-label={`Tematy · ${topics.length}`}>
        <h2 className={styles.sectionLabel}>Tematy · {topics.length}</h2>
        {topics.length === 0 ? <p className={styles.empty}>Brak tematów.</p> : (
          <ul className={styles.list}>
            {topics.map((topic, index) => (
              <li key={topic.id} className={styles.row}>
                <span className={styles.rowNumber}>{index + 1}.</span>
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>{topic.title.trim() || sourceLabel(topic.source)}</span>
                  <span className={styles.rowMeta}>{topicMeta(topic)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className={styles.section} aria-label={`Tematy · ${topics.length}`}>
      <h2 className={styles.sectionLabel}>Tematy · {topics.length}</h2>
      {listMessage ? <p className={styles.listMessage} role="status">{listMessage}</p> : null}
      {topics.length === 0 && !newTopic ? <p className={styles.empty}>Brak tematów.</p> : null}
      <ul className={styles.list}>
        {topics.map((topic, index) => {
          const expanded = topic.id === expandedId;
          const deletedLinked = topic.kind === 'linked' && topic.source.deletedAt !== null;
          const label = topic.kind === 'absorbed'
            ? (topic.title.trim() || sourceLabel(topic.source))
            : sourceLabel(topic.source);
          const draft = drafts[topic.id] ?? draftFromTopic(topic);
          return (
            <li
              key={topic.id}
              className={styles.row}
              data-drag-over={dragOverId === topic.id ? 'true' : undefined}
              draggable={!deletedLinked}
              onDragStart={(event: ReactDragEvent) => { draggedId.current = topic.id; event.dataTransfer.setData(DRAG_TYPE, topic.id); event.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(event: ReactDragEvent) => { if (!event.dataTransfer.types.includes(DRAG_TYPE)) return; event.preventDefault(); setDragOverId(topic.id); }}
              onDragLeave={() => setDragOverId((old) => (old === topic.id ? null : old))}
              onDrop={(event: ReactDragEvent) => { event.preventDefault(); void commitDrop(topic.id); }}
            >
              <span className={styles.dragHandle} aria-hidden="true">⠿</span>
              <span className={styles.rowNumber}>{index + 1}.</span>
              {deletedLinked ? (
                <span className={styles.rowBodyMuted}>Usunięta rolka · {label || 'Bez tytułu'}</span>
              ) : (
                <button type="button" className={styles.rowBody} onClick={() => void requestSwitch(expanded ? null : topic.id)} aria-expanded={expanded}>
                  <span className={styles.rowTitle}>{label}</span>
                  <span className={styles.rowMeta}>{topicMeta(topic)}</span>
                </button>
              )}
              <span className={styles.rowOverflowWrap}>
                <button type="button" className={styles.rowOverflow} aria-label="Więcej" aria-haspopup="menu" onClick={() => setMenuOpenId((old) => (old === topic.id ? null : topic.id))} disabled={rowBusy === topic.id}>
                  <OverflowIcon />
                </button>
                {menuOpenId === topic.id ? (
                  <ul className={styles.rowMenu} role="menu">
                    {!deletedLinked ? (
                      <>
                        <li><button type="button" role="menuitem" className={styles.rowMenuItem} disabled={index === 0} onClick={() => { setMenuOpenId(null); void reorder(topic.id, 'up'); }}>W górę</button></li>
                        <li><button type="button" role="menuitem" className={styles.rowMenuItem} disabled={index === topics.length - 1} onClick={() => { setMenuOpenId(null); void reorder(topic.id, 'down'); }}>W dół</button></li>
                      </>
                    ) : null}
                    <li><button type="button" role="menuitem" className={styles.rowMenuItem} onClick={() => void removeTopic(topic)}>{topic.kind === 'absorbed' ? 'Odłącz' : 'Usuń odwołanie'}</button></li>
                  </ul>
                ) : null}
              </span>

              {expanded && !deletedLinked ? (
                <div className={styles.expanded}>
                  {topic.kind === 'absorbed' ? (
                    <>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Tytuł</span>
                        <input
                          className={styles.titleInput}
                          value={draft.title}
                          onChange={(event) => changeDraftField(topic.id, 'title', event.target.value)}
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Notatki</span>
                        <textarea className={styles.textField} rows={2} value={draft.notes} onChange={(event) => changeDraftField(topic.id, 'notes', event.target.value)} />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Scenariusz</span>
                        <textarea className={styles.textField} rows={3} value={draft.script} onChange={(event) => changeDraftField(topic.id, 'script', event.target.value)} />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Źródło</span>
                        <textarea
                          className={styles.textField}
                          value={draft.publicationSource ?? topic.source.sourceMetadata?.line ?? ''}
                          onChange={(event) => changeSource(topic.id, event.target.value, topic.source.sourceMetadata?.line ?? null)}
                        />
                        <span className={styles.sourceMeta}>
                          {draft.publicationSource !== null ? 'Wpisane ręcznie' : topic.source.sourceMetadata?.line ? 'Automatycznie z linku' : 'Brak linku w materiale.'}
                        </span>
                      </label>
                      {topic.source.originalInput ? <SourceMaterialRow input={topic.source.originalInput} /> : null}
                      <TopicSaveStatus draft={draft} onRetry={() => void saveNow(topic.id)} onDiscard={() => discardDraft(topic.id)} />
                    </>
                  ) : (
                    <>
                      <p className={styles.readOnlyLine}>Status: {STATUS_LABELS[topic.source.status]}</p>
                      <p className={styles.readOnlyLine}>Edytor: {topic.source.editorId ?? 'Brak'}</p>
                      {topic.source.sourceLine ? <p className={styles.readOnlyLine}>{topic.source.sourceLine}</p> : null}
                      <TextAction onClick={() => onOpenReel?.(topic.source.reelId)}>Otwórz rolkę</TextAction>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}

        {newTopic ? (
          <li className={styles.row}>
            <div className={styles.newTopicForm}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Tytuł tematu</span>
                <input className={styles.titleInput} autoFocus value={newTopic.title} onChange={(event) => setNewTopic({ ...newTopic, title: event.target.value, error: null })} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Link</span>
                <input className={styles.titleInput} type="url" value={newTopic.link} onChange={(event) => setNewTopic({ ...newTopic, link: event.target.value })} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Notatka</span>
                <textarea className={styles.textField} rows={2} value={newTopic.note} onChange={(event) => setNewTopic({ ...newTopic, note: event.target.value })} />
              </label>
              {newTopic.error ? <p className={styles.fieldError} role="alert">{newTopic.error} <TextAction onClick={() => void submitNewTopic()}>Ponów</TextAction></p> : null}
              <div className={styles.newTopicActions}>
                <TextAction onClick={() => setNewTopic(null)}>Anuluj</TextAction>
                <button type="button" className={styles.addButton} disabled={newTopic.title.trim() === '' || newTopic.saving} onClick={() => void submitNewTopic()}>
                  {newTopic.saving ? 'Dodawanie…' : 'Dodaj'}
                </button>
              </div>
            </div>
          </li>
        ) : null}
      </ul>

      <div className={styles.listActions}>
        <TextAction onClick={() => setPickerOpen(true)}>+ Dodaj temat</TextAction>
        {!newTopic ? <TextAction onClick={() => setNewTopic({ title: '', link: '', note: '', saving: false, error: null })}>+ Nowy temat</TextAction> : null}
      </div>

      {pickerOpen ? (
        <StreamTopicPicker api={api} stream={stream} onClose={() => setPickerOpen(false)} onAdded={onAdded} />
      ) : null}
    </section>
  );
}

function topicMeta(topic: StreamTopic): string {
  const source = topic.source.sourceLine;
  if (topic.kind === 'absorbed') return source ? `Temat streamu · ${source}` : 'Temat streamu';
  const status = `Odwołanie · ${STATUS_LABELS[topic.source.status]}`;
  return source ? `${status} · ${source}` : status;
}

/** A quiet row that opens the original capture read-only (D4 `Materiał źródłowy`). */
function SourceMaterialRow({ input }: { input: NonNullable<StreamTopic['source']['originalInput']> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.field}>
      <TextAction onClick={() => setOpen((old) => !old)}>Materiał źródłowy</TextAction>
      {open ? (
        <div className={styles.sourceMaterial}>
          {input.url ? <a href={input.url} target="_blank" rel="noopener noreferrer">{input.url}</a> : null}
          {input.text ? <p>{input.text}</p> : null}
          {input.images.length > 0 ? <p>{input.images.length} zdjęcie/a</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function TopicSaveStatus({ draft, onRetry, onDiscard }: { draft: TopicDraft; onRetry: () => void; onDiscard: () => void }) {
  if (draft.saveState === 'saving') return <p className={styles.saveHint} role="status">Zapisywanie…</p>;
  if (draft.saveState === 'saved') return <p className={styles.saveHint} role="status">Zapisano</p>;
  if (draft.saveState === 'conflict' || draft.saveState === 'error') {
    return (
      <p className={styles.saveError} role="alert">
        {draft.error}
        <TextAction onClick={onRetry}>Ponów</TextAction>
        <TextAction onClick={onDiscard}>Odrzuć zmiany</TextAction>
      </p>
    );
  }
  return null;
}
