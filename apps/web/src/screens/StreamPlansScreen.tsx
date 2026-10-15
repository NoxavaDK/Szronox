import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  StreamPlan, StreamPlanCandidate, StreamPlanSummary, StreamPlanTopicView, User,
} from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { ClientApiError } from '../data/errors.js';
import { reelLabel } from '../data/reel-label.js';
import {
  blankTopic, dockUrl, draftOf, draftProblems, moveTopic, PLAN_LIMITS, planDateLabel, requestOf, sessionFrom,
  topicFromCandidate, type PlanDraft,
} from '../data/stream-plans.js';
import { topicLabel } from '../data/streams.js';
import { BackArrowIcon, ExternalLinkIcon } from '../ui/icons.js';
import { STATUS_LABELS } from '../ui/screen-contracts.js';
import '../ui/tokens.css';
import listStyles from './ReelListScreen.module.css';
import styles from './StreamPlansScreen.module.css';
import { LivePanel } from './LiveScreen.js';

/**
 * `Streamy` — STREAM-PLAN-01. A stream is set up here per broadcast, separately from Reels:
 * topics picked from recent Reels (or typed), each with its main link, extra links and points to
 * go through; the Social Stream Ninja dock for highlighting comments; and the `Na żywo` panel so
 * Szron can ping Kuba. One plan at a time is marked for StreamControl on the streaming PC.
 */

const SAVE_DELAY_MS = 800;
const LOAD_FAILED = 'Nie udało się wczytać. Sprawdź połączenie i spróbuj ponownie.';

type SaveState = 'saved' | 'dirty' | 'saving' | 'invalid' | 'conflict' | 'error';
const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Zapisano', dirty: 'Niezapisane', saving: 'Zapisywanie…', invalid: 'Nie zapisano — popraw pola niżej',
  conflict: 'Zmieniono w innym oknie', error: 'Nie zapisano — ponawiam przy następnej zmianie',
};

function candidateLabel(candidate: StreamPlanCandidate): string {
  const fallback = reelLabel({ title: '', originalInput: candidate.originalInput, script: candidate.script, sourceMetadata: candidate.sourceMetadata }).text;
  return topicLabel({ title: candidate.title, selectedHookText: candidate.selectedHookText }, fallback);
}

/** Polish count: 1 temat, 2–4 tematy, 5+ (and 12–14) tematów. */
function plural(n: number, one: string, few: string, many: string): string {
  const word = n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
  return `${n} ${word}`;
}

function nextSaturday(): string {
  const date = new Date();
  date.setDate(date.getDate() + ((6 - date.getDay() + 7) % 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function StreamPlansScreen({ api, user, planId, onOpenPlan, onBack }: {
  api: CoreApiClient;
  user: User;
  planId: string | null;
  onOpenPlan: (id: string | null) => void;
  onBack: () => void;
}) {
  return planId
    ? <PlanEditor key={planId} api={api} user={user} planId={planId} onClose={() => onOpenPlan(null)} />
    : <PlanList api={api} onOpenPlan={onOpenPlan} onBack={onBack} />;
}

// ── List ─────────────────────────────────────────────────────────────────────

function PlanList({ api, onOpenPlan, onBack }: { api: CoreApiClient; onOpenPlan: (id: string) => void; onBack: () => void }) {
  const [items, setItems] = useState<StreamPlanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('Podsumowanie tygodnia');
  const [date, setDate] = useState(nextSaturday);
  const [creating, setCreating] = useState(false);
  const operation = useRef<{ operationId: string; id: string } | null>(null);

  const load = useCallback(async () => {
    try { setItems((await api.streamPlans()).items); setError(null); } catch { setError(LOAD_FAILED); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (title.trim() === '' || creating) return;
    operation.current ??= { operationId: crypto.randomUUID(), id: crypto.randomUUID() };
    setCreating(true);
    try {
      const plan = await api.createStreamPlan({ ...operation.current, title: title.trim(), scheduledFor: date || null });
      operation.current = null;
      onOpenPlan(plan.id);
    } catch {
      setError('Nie utworzono streamu. Spróbuj ponownie.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={listStyles.screen}>
      <header className={`${listStyles.header} ${listStyles.headerStart}`}>
        <button type="button" className={listStyles.backButton} onClick={onBack} aria-label="Wstecz"><BackArrowIcon /></button>
        <h1 className={listStyles.title}>Streamy</h1>
      </header>
      <p className={styles.note}>Każdy stream ustawiasz osobno: tematy, linki, punkty do omówienia, komentarze i sygnały. To nie jest rolka.</p>

      <section className={styles.block} aria-labelledby="plan-new">
        <h2 id="plan-new" className={styles.label}>Nowy stream</h2>
        <div className={styles.createRow}>
          <input className={styles.input} aria-label="Tytuł streamu" maxLength={PLAN_LIMITS.title} value={title}
            onChange={(event) => { setTitle(event.target.value); operation.current = null; }} />
          <input className={`${styles.input} ${styles.date}`} type="date" aria-label="Data" value={date}
            onChange={(event) => { setDate(event.target.value); operation.current = null; }} />
        </div>
        <button type="button" className={styles.primary} disabled={title.trim() === '' || creating} onClick={() => void create()}>
          {creating ? 'Tworzenie…' : 'Utwórz stream'}
        </button>
      </section>

      {error ? <p className={styles.error} role="alert">{error} <button type="button" className={styles.textAction} onClick={() => void load()}>Ponów</button></p> : null}
      {items && items.length === 0 ? <p className={styles.muted}>Nie ma jeszcze żadnego streamu.</p> : null}
      <ul className={styles.planList}>
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <button type="button" className={styles.planRow} onClick={() => onOpenPlan(item.id)}>
              <span className={styles.planTitle}>{item.title}</span>
              <span className={styles.meta}>
                {planDateLabel(item.scheduledFor)} · {plural(item.topicCount, 'temat', 'tematy', 'tematów')}
                {item.isCurrent ? <strong className={styles.current}> · Bieżący na PC</strong> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────────

function PlanEditor({ api, user, planId, onClose }: { api: CoreApiClient; user: User; planId: string; onClose: () => void }) {
  const [plan, setPlan] = useState<StreamPlan | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [open, setOpen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<'current' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The latest saved version, read by the save loop without re-creating it on every keystroke.
  const base = useRef<StreamPlan | null>(null);
  const pending = useRef<{ draft: PlanDraft; operationId: string } | null>(null);
  const saving = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // While a conflict is open nothing autosaves until the user picks a version.
  const conflict = useRef(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.streamPlan(planId);
      base.current = loaded;
      setPlan(loaded);
      setDraft(draftOf(loaded));
      setSaveState('saved');
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [api, planId]);
  useEffect(() => { void load(); }, [load]);

  const flush = useCallback(async () => {
    if (saving.current || !pending.current || !base.current) return;
    const { draft: sending, operationId } = pending.current;
    if (draftProblems(sending).length > 0) { setSaveState('invalid'); return; }
    saving.current = true;
    setSaveState('saving');
    try {
      const saved = await api.updateStreamPlan(planId, requestOf(sending, operationId, base.current.version));
      base.current = saved;
      setPlan(saved);
      // Keep the editor's own text (an empty point row stays); only the live Reel state refreshes.
      setDraft((current) => current && ({ ...current, topics: current.topics.map((topic) => ({ ...topic, reel: saved.topics.find((entry) => entry.id === topic.id)?.reel ?? topic.reel })) }));
      if (pending.current?.operationId === operationId) { pending.current = null; setSaveState('saved'); }
    } catch (error) {
      if (error instanceof ClientApiError && error.api.code === 'EDIT_CONFLICT') { conflict.current = true; setSaveState('conflict'); }
      else setSaveState('error');
      saving.current = false;
      return;
    }
    saving.current = false;
    if (pending.current) void flush();
  }, [api, planId]);

  const change = (update: (current: PlanDraft) => PlanDraft) => {
    setDraft((current) => {
      if (!current) return current;
      const next = update(current);
      pending.current = { draft: next, operationId: crypto.randomUUID() };
      return next;
    });
    if (conflict.current) return;
    setSaveState('dirty');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const keepMine = async () => {
    try {
      const latest = await api.streamPlan(planId);
      base.current = latest;
      setPlan(latest);
      conflict.current = false;
      setSaveState('dirty');
      void flush();
    } catch { setSaveState('error'); }
  };

  const changeTopic = (id: string, update: (topic: StreamPlanTopicView) => StreamPlanTopicView) =>
    change((current) => ({ ...current, topics: current.topics.map((topic) => topic.id === id ? update(topic) : topic) }));

  const toggleCurrent = async () => {
    if (!base.current || busy) return;
    setBusy('current');
    setActionError(null);
    try {
      const saved = await api.setCurrentStreamPlan(planId, { operationId: crypto.randomUUID(), expectedVersion: base.current.version, current: !base.current.isCurrent });
      base.current = saved;
      setPlan(saved);
    } catch (error) {
      setActionError(error instanceof ClientApiError && error.api.code === 'EDIT_CONFLICT'
        ? 'Stream zmienił się w innym oknie. Odśwież i spróbuj ponownie.' : 'Nie udało się. Spróbuj ponownie.');
    } finally { setBusy(null); }
  };

  const remove = async () => {
    if (!base.current || busy) return;
    setBusy('delete');
    try {
      await api.deleteStreamPlan(planId, { operationId: crypto.randomUUID(), expectedVersion: base.current.version });
      onClose();
    } catch {
      setActionError('Nie usunięto. Spróbuj ponownie.');
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <div className={listStyles.screen}>
        <header className={`${listStyles.header} ${listStyles.headerStart}`}>
          <button type="button" className={listStyles.backButton} onClick={onClose} aria-label="Wstecz"><BackArrowIcon /></button>
          <h1 className={listStyles.title}>Stream</h1>
        </header>
        <p className={styles.error} role="alert">{LOAD_FAILED} <button type="button" className={styles.textAction} onClick={() => void load()}>Ponów</button></p>
      </div>
    );
  }
  if (!plan || !draft) return <div className={listStyles.screen}><p className={styles.muted}>Wczytywanie…</p></div>;

  const problems = saveState === 'invalid' ? draftProblems(draft) : [];
  const session = sessionFrom(draft.commentsSession);
  const reelIds = new Set(draft.topics.map((topic) => topic.reelId).filter(Boolean));

  return (
    <div className={`${listStyles.screen} ${styles.wide}`}>
      <header className={`${listStyles.header} ${listStyles.headerStart}`}>
        <button type="button" className={listStyles.backButton} onClick={onClose} aria-label="Wstecz do listy streamów"><BackArrowIcon /></button>
        <h1 className={listStyles.title}>Stream</h1>
        <span className={`${styles.saveState} ${saveState === 'saved' ? '' : styles.saveAttention}`} role="status">{SAVE_LABEL[saveState]}</span>
      </header>
      {saveState === 'conflict' ? (
        <p className={styles.banner} role="alert">
          Ktoś zmienił ten stream w innym oknie.
          <button type="button" className={styles.textAction} onClick={() => void keepMine()}>Zapisz moją wersję</button>
          <button type="button" className={styles.textAction} onClick={() => { pending.current = null; conflict.current = false; void load(); }}>Wczytaj ich wersję</button>
        </p>
      ) : null}
      {problems.length > 0 ? <ul className={styles.problems} role="alert">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}

      <div className={styles.columns}>
        <div className={styles.column}>
          <section className={styles.block} aria-label="Stream">
            <div className={styles.createRow}>
              <input className={`${styles.input} ${styles.planTitleInput}`} aria-label="Tytuł streamu" maxLength={PLAN_LIMITS.title} value={draft.title}
                onChange={(event) => change((current) => ({ ...current, title: event.target.value }))} />
              <input className={`${styles.input} ${styles.date}`} type="date" aria-label="Data" value={draft.scheduledFor}
                onChange={(event) => change((current) => ({ ...current, scheduledFor: event.target.value }))} />
            </div>
            <div className={styles.currentRow}>
              <button type="button" className={plan.isCurrent ? styles.currentOn : styles.secondary} disabled={busy !== null} aria-pressed={plan.isCurrent} onClick={() => void toggleCurrent()}>
                {plan.isCurrent ? 'Bieżący na PC ✓' : 'Ustaw jako bieżący na PC'}
              </button>
              <span className={styles.meta}>{plan.isCurrent ? 'StreamControl pobierze ten stream przyciskiem „Pobierz z SzroNox”.' : 'Tylko jeden stream naraz trafia do StreamControl.'}</span>
            </div>
            {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
          </section>

          <section className={styles.block} aria-labelledby="plan-topics">
            <h2 id="plan-topics" className={styles.label}>Tematy · {draft.topics.length}/{PLAN_LIMITS.topics}</h2>
            {draft.topics.length === 0 ? <p className={styles.muted}>Dodaj tematy z ostatnich rolek i pomysłów albo wpisz własny.</p> : null}
            <ol className={styles.topics}>
              {draft.topics.map((topic, index) => (
                <TopicCard
                  key={topic.id}
                  topic={topic}
                  index={index}
                  count={draft.topics.length}
                  expanded={open === topic.id}
                  onToggle={() => setOpen((current) => current === topic.id ? null : topic.id)}
                  onChange={(update) => changeTopic(topic.id, update)}
                  onMove={(delta) => change((current) => ({ ...current, topics: moveTopic(current.topics, index, delta) }))}
                  onRemove={() => change((current) => ({ ...current, topics: current.topics.filter((entry) => entry.id !== topic.id) }))}
                />
              ))}
            </ol>
            {draft.topics.length < PLAN_LIMITS.topics ? (
              picking ? (
                <TopicPicker
                  api={api}
                  taken={reelIds as Set<string>}
                  onPick={(candidate, label) => {
                    const id = crypto.randomUUID();
                    change((current) => ({ ...current, topics: [...current.topics, topicFromCandidate(candidate, label, id)] }));
                    setOpen(id);
                    setPicking(false);
                  }}
                  onOwn={() => {
                    const id = crypto.randomUUID();
                    // A typed topic starts with an empty title, which autosave refuses until it is filled.
                    setDraft((current) => current && ({ ...current, topics: [...current.topics, blankTopic(id)] }));
                    setOpen(id);
                    setPicking(false);
                  }}
                  onCancel={() => setPicking(false)}
                />
              ) : <button type="button" className={styles.secondary} onClick={() => setPicking(true)}>+ Dodaj temat</button>
            ) : <p className={styles.muted}>To już {PLAN_LIMITS.topics} tematów — tyle mieści plansza streamu.</p>}
          </section>
        </div>

        <div className={styles.column}>
          <section className={styles.block} aria-labelledby="plan-comments">
            <h2 id="plan-comments" className={styles.label}>Komentarze</h2>
            <input className={styles.input} aria-label="ID sesji Social Stream Ninja" placeholder="ID sesji Social Stream Ninja (albo link z ?session=)"
              value={draft.commentsSession} onChange={(event) => change((current) => ({ ...current, commentsSession: event.target.value }))} />
            {session ? (
              <>
                <p className={styles.meta}>Kliknij komentarz, aby wyróżnić go na streamie. Działa u Kuby i u Szrona jednocześnie.
                  {' '}<a className={styles.link} href={dockUrl(session)} target="_blank" rel="noreferrer noopener">Otwórz w osobnym oknie <ExternalLinkIcon /></a></p>
                <iframe className={styles.dock} title="Komentarze — Social Stream Ninja" src={dockUrl(session)} allow="clipboard-write" referrerPolicy="no-referrer" />
              </>
            ) : <p className={styles.meta}>Wpisz ID sesji z aplikacji Social Stream Ninja, aby widzieć i wyróżniać komentarze.</p>}
          </section>

          <section className={styles.block} aria-labelledby="plan-live">
            <h2 id="plan-live" className={styles.label}>Na żywo</h2>
            <div className={styles.livePanel}><LivePanel api={api} user={user} single /></div>
          </section>

          <section className={styles.block}>
            {confirmDelete ? (
              <p className={styles.meta}>
                Usunąć ten stream? Rolki w tematach zostają bez zmian.
                <button type="button" className={`${styles.textAction} ${styles.danger}`} disabled={busy !== null} onClick={() => void remove()}>Usuń stream</button>
                <button type="button" className={styles.textAction} onClick={() => setConfirmDelete(false)}>Anuluj</button>
              </p>
            ) : <button type="button" className={`${styles.textAction} ${styles.danger}`} onClick={() => setConfirmDelete(true)}>Usuń stream…</button>}
          </section>
        </div>
      </div>
    </div>
  );
}

// ── One topic ────────────────────────────────────────────────────────────────

function TopicCard({ topic, index, count, expanded, onToggle, onChange, onMove, onRemove }: {
  topic: StreamPlanTopicView; index: number; count: number; expanded: boolean; onToggle: () => void;
  onChange: (update: (topic: StreamPlanTopicView) => StreamPlanTopicView) => void;
  onMove: (delta: -1 | 1) => void; onRemove: () => void;
}) {
  const links = (topic.mainLink ? 1 : 0) + topic.extraLinks.filter((link) => link.url.trim()).length;
  const points = topic.points.filter((point) => point.trim()).length;
  const origin = topic.reel
    ? `${topic.reel.deleted ? 'Rolka usunięta' : STATUS_LABELS[topic.reel.status]}`
    : topic.reelId ? 'Rolka niedostępna' : 'Własny temat';
  return (
    <li className={styles.topic}>
      <button type="button" className={styles.topicHead} aria-expanded={expanded} onClick={onToggle}>
        <span className={styles.topicNumber}>{index + 1}</span>
        <span className={styles.topicHeadText}>
          <span className={styles.topicTitle}>{topic.title.trim() || 'Nowy temat'}</span>
          <span className={styles.meta}>{origin} · {plural(links, 'link', 'linki', 'linków')} · {plural(points, 'punkt', 'punkty', 'punktów')}</span>
        </span>
      </button>
      {expanded ? (
        <div className={styles.topicBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Tytuł na ekranie</span>
            <textarea className={styles.input} rows={2} maxLength={PLAN_LIMITS.topicTitle} value={topic.title}
              onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Główny link</span>
            <input className={styles.input} type="url" inputMode="url" placeholder="https://…" value={topic.mainLink ?? ''}
              onChange={(event) => onChange((current) => ({ ...current, mainLink: event.target.value }))} />
          </label>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Linki dodatkowe</span>
            {topic.extraLinks.map((link, position) => (
              <div key={position} className={styles.linkRow}>
                <input className={styles.input} type="url" inputMode="url" placeholder="https://…" aria-label={`Link dodatkowy ${position + 1}`} value={link.url}
                  onChange={(event) => onChange((current) => ({ ...current, extraLinks: current.extraLinks.map((entry, at) => at === position ? { ...entry, url: event.target.value } : entry) }))} />
                <input className={`${styles.input} ${styles.linkLabel}`} placeholder="Opis (opcjonalnie)" aria-label={`Opis linku ${position + 1}`} maxLength={PLAN_LIMITS.linkLabel} value={link.label}
                  onChange={(event) => onChange((current) => ({ ...current, extraLinks: current.extraLinks.map((entry, at) => at === position ? { ...entry, label: event.target.value } : entry) }))} />
                <button type="button" className={styles.textAction} aria-label={`Usuń link ${position + 1}`}
                  onClick={() => onChange((current) => ({ ...current, extraLinks: current.extraLinks.filter((_, at) => at !== position) }))}>Usuń</button>
              </div>
            ))}
            {topic.extraLinks.length < PLAN_LIMITS.extraLinks ? (
              <button type="button" className={styles.textAction} onClick={() => onChange((current) => ({ ...current, extraLinks: [...current.extraLinks, { url: '', label: '' }] }))}>+ Dodaj link</button>
            ) : null}
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Do omówienia</span>
            <ol className={styles.points}>
              {topic.points.map((point, position) => (
                <li key={position} className={styles.pointRow}>
                  <input className={styles.input} aria-label={`Punkt ${position + 1}`} maxLength={PLAN_LIMITS.point} value={point}
                    onChange={(event) => onChange((current) => ({ ...current, points: current.points.map((entry, at) => at === position ? event.target.value : entry) }))} />
                  <button type="button" className={styles.textAction} aria-label={`Usuń punkt ${position + 1}`}
                    onClick={() => onChange((current) => ({ ...current, points: current.points.filter((_, at) => at !== position) }))}>Usuń</button>
                </li>
              ))}
            </ol>
            {topic.points.length < PLAN_LIMITS.points ? (
              <button type="button" className={styles.textAction} onClick={() => onChange((current) => ({ ...current, points: [...current.points, ''] }))}>+ Dodaj punkt</button>
            ) : null}
          </div>

          <div className={styles.topicActions}>
            <button type="button" className={styles.textAction} disabled={index === 0} onClick={() => onMove(-1)}>W górę</button>
            <button type="button" className={styles.textAction} disabled={index === count - 1} onClick={() => onMove(1)}>W dół</button>
            <button type="button" className={`${styles.textAction} ${styles.danger}`} onClick={onRemove}>Usuń temat</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ── Picker ───────────────────────────────────────────────────────────────────

function TopicPicker({ api, taken, onPick, onOwn, onCancel }: {
  api: CoreApiClient; taken: Set<string>;
  onPick: (candidate: StreamPlanCandidate, label: string) => void; onOwn: () => void; onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<StreamPlanCandidate[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      api.streamPlanCandidates(query)
        .then((response) => { if (live) { setItems(response.items); setError(false); } })
        .catch(() => { if (live) setError(true); });
    }, query ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, query]);

  return (
    <div className={styles.picker}>
      <input className={styles.input} type="search" autoFocus placeholder="Szukaj w rolkach i pomysłach…" aria-label="Szukaj tematu" value={query} onChange={(event) => setQuery(event.target.value)} />
      <p className={styles.meta}>{query ? 'Wyniki wyszukiwania' : 'Ostatnie rolki i pomysły'}</p>
      {error ? <p className={styles.error} role="alert">{LOAD_FAILED}</p> : null}
      {items && items.length === 0 ? <p className={styles.muted}>Nic nie znaleziono.</p> : null}
      <ul className={styles.candidates}>
        {(items ?? []).map((candidate) => {
          const label = candidateLabel(candidate);
          const inPlan = taken.has(candidate.id);
          return (
            <li key={candidate.id}>
              <button type="button" className={styles.candidate} disabled={inPlan} onClick={() => onPick(candidate, label)}>
                <span className={styles.candidateTitle}>{label}</span>
                <span className={styles.meta}>{inPlan ? 'Już w tym streamie' : STATUS_LABELS[candidate.status]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.topicActions}>
        <button type="button" className={styles.textAction} onClick={onOwn}>Wpisz własny temat</button>
        <button type="button" className={styles.textAction} onClick={onCancel}>Anuluj</button>
      </div>
    </div>
  );
}
