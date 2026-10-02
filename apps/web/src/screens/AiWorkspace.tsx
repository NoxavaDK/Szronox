import { useEffect, useRef, useState } from 'react';
import type { AiAction, AiRun, ApplyAiRequest, DevelopResult, FactCheckResult, LanguageResult, Meme, ProgrammeResult, PublicationResult, Reel } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { ClientApiError, isAbandonedRequest, polishError } from '../data/errors.js';
import { reelLabel } from '../data/reel-label.js';
import styles from './AiWorkspace.module.css';

type View = AiAction | 'attached_programme';
const title: Record<View, string> = {
  develop: 'Opracowanie', generate_hooks: 'Hooki', fact_check: 'Sprawdź fakty',
  language_check: 'Sprawdź język', find_programme: 'Sprawdź postulat',
  generate_publication: 'Opis publikacji', attached_programme: 'Postulat',
};
const actionLabel: Record<AiAction, string> = {
  develop: 'Opracuj', generate_hooks: 'Wygeneruj więcej', fact_check: 'Sprawdź fakty',
  language_check: 'Sprawdź język', find_programme: 'Sprawdź postulat',
  generate_publication: 'Wygeneruj opis',
};
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className={styles.section}><h2>{label}</h2>{children}</section>;
}

export function AiWorkspace({ api, reel, initialView, autoStart, programmeIndexed, onClose, onReel, onRefresh, onSwitch }:
  { api: CoreApiClient; reel: Reel; initialView: View; autoStart: boolean; programmeIndexed: boolean;
    onClose: () => void; onReel: (reel: Reel) => void; onRefresh: () => Promise<void>; onSwitch: (view: View, autoStart?: boolean) => void }) {
  const [run, setRun] = useState<AiRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmField, setConfirmField] = useState<'publication_description' | 'publication_hashtags' | null>(null);
  const [suggestedMeme, setSuggestedMeme] = useState<Meme | null>(null);
  const operationRef = useRef(crypto.randomUUID());
  const refreshedRun = useRef<string | null>(null);
  const action = initialView === 'attached_programme' ? null : initialView;

  async function begin(next: AiAction = action ?? 'find_programme', operationId = crypto.randomUUID()) {
    setBusy(true); setMessage(null);
    try {
      const current = await api.reel(reel.id);
      onReel(current);
      const queued = await api.startAi(current.id, { operationId, expectedVersion: current.version, action: next });
      // Edits made to a previous publication proposal do not carry over to a new one.
      if (next === 'generate_publication') { setDrafts({}); setConfirmField(null); }
      setRun(await api.aiRun(queued.id));
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!action) return;
    let live = true;
    setRun(null); setMessage(null); setDrafts({}); refreshedRun.current = null;
    const load = async () => {
      try {
        if (autoStart) {
          const current = await api.reel(reel.id);
          if (!live) return;
          onReel(current);
          const queued = await api.startAi(current.id, { operationId: operationRef.current, expectedVersion: current.version, action });
          if (live) setRun(await api.aiRun(queued.id));
        } else {
          const latest = await api.latestAi(reel.id, action);
          if (!live) return;
          // A publication proposal written from a script that has since changed can no
          // longer be applied, so Wygeneruj opis generates afresh instead of reopening it.
          if (latest.run && !(action === 'generate_publication' && latest.run.isStale)) setRun(latest.run);
          else {
            const current = await api.reel(reel.id);
            if (!live) return;
            onReel(current);
            const queued = await api.startAi(current.id, { operationId: operationRef.current, expectedVersion: current.version, action });
            if (live) setRun(await api.aiRun(queued.id));
          }
        }
      } catch (error) { if (live && !isAbandonedRequest(error)) setMessage(polishError(error)); }
    };
    void load();
    return () => { live = false; };
    // A view change remounts this component; Reel updates must not restart a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, api, reel.id]);

  useEffect(() => {
    if (!run || (run.state !== 'queued' && run.state !== 'running')) return;
    let live = true;
    const timer = window.setInterval(() => {
      void api.aiRun(run.id).then((next) => { if (live) setRun(next); })
        .catch((error) => { if (live && !isAbandonedRequest(error)) setMessage(polishError(error)); });
    }, 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [api, run?.id, run?.state]);

  useEffect(() => {
    if (run?.state !== 'succeeded' || refreshedRun.current === run.id) return;
    refreshedRun.current = run.id;
    void onRefresh();
  }, [run?.id, run?.state, onRefresh]);

  useEffect(() => {
    const candidate = run?.action === 'develop' ? (run.result as DevelopResult | null)?.memeSuggestion : null;
    if (!candidate) { setSuggestedMeme(null); return; }
    let live = true;
    void api.memes().then(({ items }) => { if (live) setSuggestedMeme(items.find((item) => item.id === candidate.memeId) ?? null); })
      .catch(() => { if (live) setSuggestedMeme(null); });
    return () => { live = false; };
  }, [api, run?.id, run?.state]);

  async function apply(selection: ApplyAiRequest['selection'], value: Record<string, unknown> = {}) {
    if (!run) return;
    setBusy(true); setMessage(null);
    try {
      const updated = await api.applyAi(run.id, { operationId: crypto.randomUUID(), expectedVersion: reel.version, selection, ...value } as ApplyAiRequest);
      onReel(updated);
      setRun(await api.aiRun(run.id));
      setConfirmField(null);
      setMessage('Zapisano zmianę.');
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      if (error instanceof ClientApiError && error.api.code === 'EDIT_CONFLICT' &&
          (selection === 'publication_description' || selection === 'publication_hashtags')) {
        try {
          onReel(await api.reel(reel.id));
          setConfirmField(selection);
          setMessage('Zapisany tekst zmienił się. Sprawdź jego aktualną wersję i potwierdź zastąpienie ponownie.');
        } catch (refreshError) { if (!isAbandonedRequest(refreshError)) setMessage(polishError(refreshError)); }
      } else {
        setMessage(polishError(error));
        // A stale publication result is shown as such; the proposal text stays editable.
        if (error instanceof ClientApiError && error.api.code === 'STALE_PUBLICATION_RESULT') {
          setConfirmField(null);
          try { onReel(await api.reel(reel.id)); setRun(await api.aiRun(run.id)); }
          catch (refreshError) { if (!isAbandonedRequest(refreshError)) setMessage(polishError(refreshError)); }
        }
      }
    }
    finally { setBusy(false); }
  }

  async function attachMeme(memeId: string) {
    setBusy(true);
    try {
      const updated = await api.attachMeme(reel.id, { operationId: crypto.randomUUID(), expectedVersion: reel.version, memeId });
      onReel(updated); setMessage('Dodano mem.');
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
    finally { setBusy(false); }
  }

  async function removeHook(hookId: string) {
    setBusy(true); setMessage(null);
    try {
      const updated = await api.removeHook(reel.id, hookId, { operationId: crypto.randomUUID(), expectedVersion: reel.version });
      onReel(updated);
      if (run) setRun(await api.aiRun(run.id));
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
    finally { setBusy(false); }
  }

  const d = run?.action === 'develop' && run.result ? run.result as DevelopResult : null;
  const f = run?.action === 'fact_check' && run.result ? run.result as FactCheckResult : null;
  const l = run?.action === 'language_check' && run.result ? run.result as LanguageResult : null;
  const p = run?.action === 'find_programme' && run.result ? run.result as ProgrammeResult : null;
  const pub = run?.action === 'generate_publication' && run.result ? run.result as PublicationResult : null;
  /**
   * One publication field: an editable proposal, the saved value beside it, and explicit
   * application. An empty target applies on Zastosuj; a filled one asks first. Nothing is
   * written by generation itself, and cancelling keeps the saved text.
   */
  const publicationField = (selection: 'publication_description' | 'publication_hashtags', key: string, suggestion: string) => {
    const description = selection === 'publication_description';
    const current = description ? reel.publicationDescription : reel.publicationHashtags;
    const text = fieldDraft(key, suggestion);
    const submit = () => void apply(selection, { text, replaceCurrentValue: current, confirmReplacement: true });
    return <Section label={description ? 'OPIS' : 'HASHTAGI'}>
      <textarea aria-label={description ? 'Propozycja opisu' : 'Propozycja hashtagów'} value={text} onChange={(event) => edit(key, event.target.value)} />
      {current ? <p className={styles.quiet}>{description ? 'Zapisany opis' : 'Zapisane hashtagi'}: {current}</p> : null}
      {confirmField === selection ? <div className={styles.confirm}>
        <p>{description ? 'Zastąpić obecny opis tą propozycją?' : 'Zastąpić obecne hashtagi tą propozycją?'}</p>
        <button type="button" disabled={busy} onClick={submit}>{description ? 'Zastąp opis' : 'Zastąp hashtagi'}</button>
        <button type="button" onClick={() => setConfirmField(null)}>{description ? 'Zachowaj obecny' : 'Zachowaj obecne'}</button>
      </div> : <button type="button" disabled={busy || run?.isStale} onClick={() => { if (current) setConfirmField(selection); else submit(); }}>Zastosuj</button>}
    </Section>;
  };
  const label = reelLabel(reel).text;
  const fieldDraft = (key: string, initial: string) => drafts[key] ?? initial;
  const edit = (key: string, value: string) => setDrafts((previous) => ({ ...previous, [key]: value }));
  const source = (id: string) => f?.sources.find((item) => item.id === id);

  return <div className={styles.screen}>
    <header className={styles.header}><h1>{title[initialView]}</h1><button type="button" onClick={onClose} aria-label="Zamknij">×</button></header>
    <p className={styles.context}>{label}</p>
    {message ? <p className={styles.message} role="status">{message}</p> : null}
    {initialView === 'attached_programme' && reel.programmeAttachment ? <>
      <Section label={reel.programmeAttachment.strength === 'strong' ? 'MOCNE DOPASOWANIE' : 'POŚREDNIE DOPASOWANIE'}>
        <p className={styles.quiet}>{reel.programmeAttachment.category}</p>
        <h3>{reel.programmeAttachment.proposal}</h3>
        <p className={styles.minor}>FRAGMENT PROGRAMU</p>
        <p>{reel.programmeAttachment.excerpt}</p>
        <a className={styles.source} href={reel.programmeAttachment.sourceUrl} target="_blank" rel="noopener noreferrer">{reel.programmeAttachment.sourceTitle} · s. {reel.programmeAttachment.pdfPages.join(', ')} ↗</a>
        <p className={styles.minor}>DLACZEGO PASUJE</p><p>{reel.programmeAttachment.rationale}</p>
      </Section>
      <div className={styles.actions}>
        <button type="button" onClick={() => onSwitch('find_programme', true)}>Zmień postulat</button>
        <button type="button" onClick={() => { void api.detachProgramme(reel.id, { operationId: crypto.randomUUID(), expectedVersion: reel.version })
          .then((updated) => { onReel(updated); onClose(); }).catch((error) => setMessage(polishError(error))); }}>Odłącz</button>
      </div>
    </> : null}

    {action && !run && !message ? <p className={styles.quiet}>Wczytywanie…</p> : null}
    {action && !run && !busy && message ? <button type="button" onClick={() => void begin()}>{actionLabel[action]}</button> : null}
    {run?.state === 'queued' || run?.state === 'running' ? <p className={styles.quiet} role="status">Trwa opracowywanie… Wynik będzie dostępny po ponownym otwarciu.</p> : null}
    {run?.state === 'failed' ? <><p className={styles.message} role="alert">Nie udało się ukończyć. {run.error ? polishError(new ClientApiError(503, run.error)) : ''}</p><button type="button" onClick={() => void begin()}>Spróbuj ponownie</button></> : null}
    {run?.isStale ? <p className={styles.message}>{run.action === 'generate_publication'
      ? 'Skrypt, wybrany hook lub źródła zmieniły się od wygenerowania opisu. Wygeneruj opis ponownie.'
      : 'Treść rolki zmieniła się od tego opracowania. Przed użyciem propozycji sprawdź aktualny tekst.'}</p> : null}
    {run?.warnings.filter((warning) => !(pub?.publicationGrounding && warning.startsWith('Nie znaleziono wiarygodnych materiałów')))
      .map((warning, index) => <p className={styles.message} key={index}>{warning}</p>)}

    {d ? <>
      <Section label="CO SIĘ WYDARZYŁO"><p>{d.eventSummary}</p></Section>
      <Section label="DO SPRAWDZENIA">{d.verificationIssues.length ? d.verificationIssues.map((issue, index) => <p key={index} className={styles.warning}>◇ {issue}</p>) : <p className={styles.quiet}>Brak dodatkowych pytań.</p>}</Section>
      <Section label="HOOKI">
        {reel.hooks.map((hook) => <div className={styles.hook} key={hook.id}><p>{hook.source === 'user' ? <span className={styles.minor}>TWÓJ HOOK · </span> : null}{hook.text}</p><button type="button" disabled={busy} aria-label="Usuń hook" onClick={() => void removeHook(hook.id)}>×</button></div>)}
        <button type="button" disabled={busy} onClick={() => onSwitch('generate_hooks', true)}>+ Wygeneruj więcej</button>
      </Section>
      <Section label="SCENARIUSZ"><p className={styles.preserve}>{d.scriptSuggestion}</p><button type="button" disabled={busy} onClick={() => void apply('script', { text: d.scriptSuggestion })}>Zastosuj</button></Section>
      <Section label="MEM">{d.memeSuggestion && suggestedMeme ? <><div className={styles.meme}>{suggestedMeme.thumbnailRef ? <img src={suggestedMeme.thumbnailRef} alt="" /> : <span aria-label="wideo" className={styles.memeVideoPlaceholder}>▧</span>}{suggestedMeme.mediaKind === 'video' ? <span aria-label="wideo" title="wideo">▶</span> : null}<p>{suggestedMeme.name}</p></div><p className={styles.quiet}>{d.memeSuggestion.rationale}</p>{d.memeSuggestion.relevantFragment ? <p className={styles.quiet}>{d.memeSuggestion.relevantFragment}</p> : null}<button type="button" disabled={busy} onClick={() => void attachMeme(d.memeSuggestion!.memeId)}>+ Dodaj</button></> : <p className={styles.quiet}>Brak propozycji z biblioteki memów.</p>}</Section>
      <Section label="TYTUŁ ROBOCZY"><input aria-label="Propozycja tytułu" value={fieldDraft('title', d.titleSuggestion)} onChange={(event) => edit('title', event.target.value)} /><button type="button" disabled={busy} onClick={() => void apply('title', { text: fieldDraft('title', d.titleSuggestion) })}>Zapisz tytuł</button></Section>
      <Section label="PRIORYTET">{d.prioritySuggestion ? <><p>{d.prioritySuggestion.priority === 'urgent' ? 'Pilne' : d.prioritySuggestion.priority === 'normal' ? 'Normalne' : 'Ponadczasowe'}</p><p className={styles.quiet}>{d.prioritySuggestion.rationale}</p><button type="button" disabled={busy} onClick={() => void apply('priority', { priority: d.prioritySuggestion!.priority })}>Ustaw {d.prioritySuggestion.priority === 'urgent' ? 'Pilne' : d.prioritySuggestion.priority === 'normal' ? 'Normalne' : 'Ponadczasowe'}</button></> : <p className={styles.quiet}>Bez zmiany priorytetu.</p>}</Section>
      <Section label="PROGRAM ZIELONYCH"><p>{d.possibleProgrammeConnection ?? 'Brak wstępnej propozycji.'}</p><button type="button" disabled={!programmeIndexed} onClick={() => onSwitch('find_programme', true)}>Sprawdź postulat</button>{!programmeIndexed ? <p className={styles.quiet}>Zatwierdzony indeks programu nie jest jeszcze dostępny.</p> : null}</Section>
      <button type="button" className={styles.bottom} onClick={() => void begin('develop')}>Opracuj ponownie</button>
    </> : null}

    {run?.action === 'generate_hooks' && run.state === 'succeeded' ? <Section label="HOOKI">{reel.hooks.map((hook) => <p key={hook.id}>{hook.text}</p>)}<button type="button" disabled={busy} onClick={() => void begin('generate_hooks')}>+ Wygeneruj więcej</button></Section> : null}

    {pub ? <>
      {publicationField('publication_description', 'description', pub.publicationDescriptionSuggestion)}
      {publicationField('publication_hashtags', 'hashtags', pub.publicationHashtagsSuggestion)}
      {/* UI-02 H: evidence for this proposal only — never inserted into the copy itself. */}
      {pub.publicationGrounding ? <Section label="ŹRÓDŁA">
        <p className={styles.quiet}>{pub.publicationGrounding === 'saved_material'
          ? 'Opis uzupełniono na podstawie zapisanych materiałów rolki.'
          : pub.publicationGrounding === 'web_search'
            ? 'Rolka nie miała użytecznych materiałów, więc informacje uzupełniono z wyszukiwania.'
            : 'Nie znaleziono wiarygodnych materiałów uzupełniających — opis oparto tylko na skrypcie.'}</p>
        {(pub.publicationSources ?? []).map((item) => <a key={item.id} className={styles.source} href={item.url} target="_blank" rel="noopener noreferrer">
          {item.origin === 'saved_link' ? 'Link z rolki' : item.title} · {hostOf(item.url)} ↗
        </a>)}
      </Section> : null}
      <button type="button" className={styles.bottom} disabled={busy} onClick={() => void begin('generate_publication')}>Wygeneruj ponownie</button>
    </> : null}

    {l ? <>
      <Section label="DO POPRAWY">{l.notes.map((note, index) => <p key={index}>{note}</p>)}</Section>
      <Section label="WERSJA A"><p className={styles.quiet}>Twój tekst</p><textarea aria-label="Wersja A" value={fieldDraft('A', run!.input.script)} onChange={(event) => edit('A', event.target.value)} /><button type="button" disabled={busy} onClick={() => void apply('language_version', { version: 'A', text: fieldDraft('A', run!.input.script) })}>Użyj wersji A</button></Section>
      <Section label="WERSJA B"><p className={styles.quiet}>Propozycja po korekcie</p><textarea aria-label="Wersja B" value={fieldDraft('B', l.scriptSuggestion)} onChange={(event) => edit('B', event.target.value)} /><button type="button" disabled={busy} onClick={() => void apply('language_version', { version: 'B', text: fieldDraft('B', l.scriptSuggestion) })}>Użyj wersji B</button></Section>
      <button type="button" className={styles.bottom} onClick={() => void begin('language_check')}>Sprawdź ponownie</button>
    </> : null}

    {f ? <>
      <p className={styles.context}>{f.claims.length} twierdzenia · {f.claims.filter((claim) => claim.status !== 'confirmed').length} wymagają uwagi</p>
      {f.claims.map((claim) => <Section key={claim.id} label={claim.status === 'confirmed' ? 'POTWIERDZONE' : claim.status === 'uncertain' ? 'NIEPEWNE' : 'SPRZECZNE ZE ŹRÓDŁAMI'}>
        <p className={styles.claim}>{claim.text}</p><p className={styles.minor}>WYJAŚNIENIE</p><p>{claim.explanation}</p>
        {claim.sourceIds.length ? <><p className={styles.minor}>ŹRÓDŁA</p>{claim.sourceIds.map((id) => { const item = source(id); return item ? <a key={id} className={styles.source} href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a> : null; })}</> : null}
        {claim.correction ? <><p className={styles.minor}>PROPONOWANA KOREKTA</p><p>{claim.correction}</p><button type="button" disabled={busy || claim.applied !== null || claim.isStale} onClick={() => void apply('fact_correction', { claimId: claim.id })}>{claim.applied ? 'Zastosowano' : 'Użyj korekty'}</button></> : null}
      </Section>)}
      <button type="button" className={styles.bottom} onClick={() => void begin('fact_check')}>Sprawdź ponownie</button>
    </> : null}

    {p ? <>
      {p.candidates.map((candidate) => <Section key={candidate.candidateId} label={candidate.strength === 'strong' ? 'MOCNE DOPASOWANIE' : 'POŚREDNIE DOPASOWANIE'}>
        <p className={styles.quiet}>{candidate.category}</p><h3>{candidate.proposal}</h3><p className={styles.minor}>FRAGMENT PROGRAMU</p><p>{candidate.excerpt}</p>
        <a className={styles.source} href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer">{candidate.sourceTitle} · s. {candidate.pdfPages.join(', ')} ↗</a><p className={styles.minor}>DLACZEGO PASUJE</p><p>{candidate.rationale}</p>
        <button type="button" disabled={busy} onClick={() => void apply('programme_match', { candidateId: candidate.candidateId })}>Przypnij</button>
      </Section>)}
      <button type="button" className={styles.bottom} disabled={busy} onClick={() => void apply('programme_no_match')}>Nie ma dobrego dopasowania</button>
    </> : null}
  </div>;
}
