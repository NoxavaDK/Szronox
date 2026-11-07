import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MonitorApiClient } from '../data/monitor.js';
import { warsawToday } from '../data/monitor.js';
import type { MonitorPlatform, MonitorPost, MonitorReport, MonitorSource } from '../data/monitor.js';
import { ClientApiError } from '../data/errors.js';
import styles from './MonitorScreen.module.css';

type MainTab = 'report' | 'posts';
type FormState = { id: string | null; version: number | null; name: string; groupLabel: string; platform: MonitorPlatform; profileUrl: string; active: boolean };

const LABELS = { fact: 'Fakt', opinion: 'Opinia', mixed: 'Mieszane' } as const;
const PLATFORM_NAMES = { facebook: 'Facebook', x: 'X' } as const;
const today = warsawToday;
const newId = () => crypto.randomUUID();

function dayLabel(value: string): string {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString('pl-PL', {
    weekday: 'short', day: 'numeric', month: 'long', timeZone: 'Europe/Warsaw',
  });
}

function moveDay(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function timeLabel(value: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }).format(new Date(value));
}

function postDateLabel(post: MonitorPost, day: string): string {
  const value = post.publishedAt ?? post.firstSeenAt;
  const postDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(value));
  if (post.publishedAt && postDay === day) return timeLabel(post.publishedAt);
  if (post.publishedAt) {
    return `${new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(post.publishedAt))} ${timeLabel(post.publishedAt)}`;
  }
  return `widziany ${timeLabel(post.firstSeenAt)}`;
}

function collectionStatus(source: MonitorReport['sources'][number]): string {
  switch (source.status) {
    case 'ok': return 'Zebrano';
    case 'login_wall': return 'Wymaga logowania';
    case 'parse_failure': return 'Nie odczytano strony';
    case 'error': return 'Błąd';
    default: return 'Nie dziś';
  }
}

function sourceStatus(source: MonitorSource): string {
  if (!source.lastStatus) return 'Jeszcze nie zbierano';
  if (source.lastStatus === 'login_wall') return 'Wymaga logowania';
  if (source.lastStatus === 'parse_failure') return 'Nie odczytano strony';
  if (source.lastStatus === 'error') return 'Błąd';
  const collectedAt = source.lastCollectedAt ?? source.lastStatusAt;
  if (!collectedAt) return 'Zebrano';
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(collectedAt));
  return date === today() ? `Zebrano · dziś ${timeLabel(collectedAt)}`
    : `Zebrano · ${new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(collectedAt))} ${timeLabel(collectedAt)}`;
}

function validProfileUrl(value: string): boolean {
  try { const url = new URL(value.trim()); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}

function mediaLine(post: MonitorPost): string {
  const videos = post.media.filter((url) => /\.(?:mp4|mov|m4v|webm)(?:\?|$)|video/i.test(url)).length;
  const photos = Math.max(0, post.media.length - videos);
  const parts: string[] = [];
  if (photos) parts.push(`${photos} ${photos === 1 ? 'zdjęcie' : photos < 5 ? 'zdjęcia' : 'zdjęć'}`);
  if (videos) parts.push(`${videos} ${videos === 1 ? 'wideo' : 'wideo'}`);
  const labels: Record<string, string> = { likes: 'polubień', reactions: 'reakcji', replies: 'odp.', comments: 'komentarzy', reposts: 'udostępnień', views: 'wyświetleń', shares: 'udostępnień' };
  for (const [key, value] of Object.entries(post.engagement)) parts.push(`${value} ${labels[key] ?? key}`);
  return parts.join(' · ');
}

function markdownReport(report: MonitorReport, numberByUrl: Map<string, number>): string {
  const synthesis = report.synthesis;
  if (!synthesis) return '';
  const refs = (urls: string[]) => urls.map((url) => `[Post ${numberByUrl.get(url) ?? '?'}](${url})`).join(' · ');
  const lines = [`# Raport monitoringu · ${report.date}`, '', `Posty: ${report.postCount}`, ''];
  const section = (title: string, rows: string[]) => { if (rows.length) lines.push(`## ${title}`, '', ...rows, ''); };
  section('Główne tematy', synthesis.mainTopics.map((row) => `### ${row.topic}\n\n${row.summary}\n\n${refs(row.postUrls)}`));
  section('Powtarzane przekazy', synthesis.repeatedMessaging.map((row) => `- ${row.message} — ${row.groups.join(', ')}\n  ${refs(row.postUrls)}`));
  section('Różnice między grupami', synthesis.groupDifferences.map((row) => `- **${row.group}** ${row.description}\n  ${refs(row.postUrls)}`));
  section('Cytaty', synthesis.notableQuotes.map((row) => `> „${row.quote}”\n>\n> ${LABELS[row.label]} · ${refs([row.postUrl])}`));
  section('Pomysły na filmiki', synthesis.videoIdeas.map((row) => `### ${row.title}\n\n${row.angle}\n\n${refs(row.postUrls)}`));
  return lines.join('\n');
}

export function MonitorScreen({
  api, date, onDateChange, tab, onTabChange, onBack, onOpenReel,
}: {
  api: MonitorApiClient;
  date: string;
  onDateChange: (date: string) => void;
  tab: MainTab;
  onTabChange: (tab: MainTab) => void;
  onBack: () => void;
  onOpenReel: (id: string) => void;
}) {
  const [subview, setSubview] = useState<'monitor' | 'sources'>('monitor');
  const [report, setReport] = useState<MonitorReport | null>(null);
  const [allPosts, setAllPosts] = useState<MonitorPost[]>([]);
  const [sources, setSources] = useState<MonitorSource[]>([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [collectionExpanded, setCollectionExpanded] = useState(false);
  const [group, setGroup] = useState('Wszystkie');
  const [platforms, setPlatforms] = useState({ facebook: true, x: true });
  const [visibleCount, setVisibleCount] = useState(50);
  const [expandedTexts, setExpandedTexts] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reelBusy, setReelBusy] = useState<Set<string>>(new Set());
  const [reelErrors, setReelErrors] = useState<Set<string>>(new Set());
  const [reportBusy, setReportBusy] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const loadDay = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const pageItems: MonitorPost[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.posts({ date, before: cursor, limit: 100 });
        pageItems.push(...page.items);
        cursor = page.nextBefore ?? undefined;
      } while (cursor);
      setAllPosts(pageItems);
      try { setReport(await api.report(date)); }
      catch (error) {
        if (error instanceof ClientApiError && error.status === 404) setReport(null);
        else throw error;
      }
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [api, date]);

  useEffect(() => { void loadDay(true); }, [loadDay]);
  useEffect(() => {
    let live = true;
    void api.sources().then((response) => { if (live) setSources(response.items); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    if (!report || (report.state !== 'queued' && report.state !== 'running')) return undefined;
    const timer = window.setInterval(() => { void loadDay(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [report?.state, loadDay]);
  useEffect(() => {
    if (subview !== 'sources') return;
    let live = true;
    void api.sources().then((response) => { if (live) { setSources(response.items); setOffline(false); } })
      .catch(() => { if (live) setOffline(true); });
    return () => { live = false; };
  }, [api, subview]);
  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
  }, []);

  const numberByUrl = useMemo(() => {
    const map = new Map<string, number>();
    allPosts.slice().reverse().forEach((post, index) => map.set(post.url, index + 1));
    return map;
  }, [allPosts]);
  const labelByUrl = useMemo(() => new Map(report?.synthesis?.postLabels.map((item) => [item.postUrl, item.label]) ?? []), [report]);
  const groups = useMemo(() => [...new Set(sources.filter((source) => source.active).map((source) => source.groupLabel))].sort((a, b) => a.localeCompare(b, 'pl')), [sources]);
  const filteredPosts = useMemo(() => allPosts.filter((post) =>
    (group === 'Wszystkie' || post.groupLabel === group) && platforms[post.platform]), [allPosts, group, platforms]);
  const shownPosts = filteredPosts.slice(0, visibleCount);

  const openReference = (url: string) => {
    const post = allPosts.find((row) => row.url === url);
    if (!post) return;
    setGroup('Wszystkie');
    setPlatforms({ facebook: true, x: true });
    onTabChange('posts');
    const index = allPosts.findIndex((row) => row.id === post.id);
    setVisibleCount(Math.max(50, Math.ceil((index + 1) / 50) * 50));
    setHighlighted(post.id);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlighted(null), 1_500);
    window.setTimeout(() => document.getElementById(`monitor-post-${post.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  };

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(markdownReport(report, numberByUrl));
      setCopyError(false);
    } catch {
      setCopyError(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyError(false), 3_000);
    }
  };

  const prepareReport = async () => {
    setReportBusy(true);
    try { setReport(await api.regenerateReport(date, newId())); setOffline(false); }
    catch { setOffline(true); }
    finally { setReportBusy(false); }
  };

  const openForm = (source: MonitorSource | null) => {
    setFormError('');
    setForm(source ? {
      id: source.id, version: source.version, name: source.name, groupLabel: source.groupLabel,
      platform: source.platform, profileUrl: source.profileUrl, active: source.active,
    } : { id: null, version: null, name: '', groupLabel: '', platform: 'facebook', profileUrl: '', active: true });
  };

  const saveSource = async () => {
    if (!form) return;
    const cleanUrl = form.profileUrl.trim();
    if (!validProfileUrl(cleanUrl)) { setFormError('Podaj pełny adres zaczynający się od https://'); return; }
    if (sources.some((source) => source.profileUrl.toLowerCase() === cleanUrl.toLowerCase() && source.id !== form.id)) {
      setFormError('To źródło już jest na liście.'); return;
    }
    setSaving(true); setFormError('');
    try {
      if (form.id && form.version !== null) {
        await api.patchSource(form.id, {
          operationId: newId(), expectedVersion: form.version,
          changes: { name: form.name, groupLabel: form.groupLabel, profileUrl: cleanUrl, active: form.active },
        });
      } else {
        await api.createSource({
          operationId: newId(), sourceId: newId(), name: form.name, groupLabel: form.groupLabel,
          platform: form.platform, profileUrl: cleanUrl,
        });
      }
      setForm(null);
      setSources((await api.sources()).items);
      setOffline(false);
    } catch (error) {
      const apiError = error instanceof ClientApiError ? error.api : null;
      const details = apiError?.details as { reason?: string } | undefined;
      setFormError(details?.reason === 'duplicate_profile' ? 'To źródło już jest na liście.'
        : apiError?.code === 'EDIT_CONFLICT' ? 'Ktoś zmienił to źródło. Odśwież i spróbuj ponownie.'
          : 'Nie udało się zapisać źródła. Spróbuj ponownie.');
    } finally { setSaving(false); }
  };

  const toggleSource = async () => {
    if (!form?.id || form.version === null) return;
    setSaving(true); setFormError('');
    try {
      await api.patchSource(form.id, {
        operationId: newId(), expectedVersion: form.version,
        changes: { name: form.name, groupLabel: form.groupLabel, profileUrl: form.profileUrl.trim(), active: !form.active },
      });
      setForm(null);
      setSources((await api.sources()).items);
      setOffline(false);
    } catch (error) {
      const apiError = error instanceof ClientApiError ? error.api : null;
      setFormError(apiError?.code === 'EDIT_CONFLICT' ? 'Ktoś zmienił to źródło. Odśwież i spróbuj ponownie.' : 'Nie udało się zmienić źródła. Spróbuj ponownie.');
    } finally { setSaving(false); }
  };

  const createReel = async (post: MonitorPost) => {
    if (post.reelId) { onOpenReel(post.reelId); return; }
    setReelBusy((old) => new Set(old).add(post.id));
    setReelErrors((old) => { const next = new Set(old); next.delete(post.id); return next; });
    try {
      const result = await api.createReel(post.id, { operationId: newId(), reelId: newId() });
      setAllPosts((old) => old.map((item) => item.id === post.id ? { ...item, reelId: result.id } : item));
    } catch {
      setReelErrors((old) => new Set(old).add(post.id));
      void loadDay();
    } finally { setReelBusy((old) => { const next = new Set(old); next.delete(post.id); return next; }); }
  };

  const collectionProblems = report?.sources.filter((source) => source.status !== 'ok') ?? [];
  const allSourceGroups = [...new Set(sources.map((source) => source.groupLabel))].sort((a, b) => a.localeCompare(b, 'pl'));
  const activeSources = sources.filter((source) => source.active).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel, 'pl') || a.name.localeCompare(b.name, 'pl'));
  const inactiveSources = sources.filter((source) => !source.active).sort((a, b) => a.name.localeCompare(b.name, 'pl'));

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        {subview === 'sources' ? <button type="button" className={styles.back} onClick={() => { setForm(null); setSubview('monitor'); }}>‹ Monitoring</button>
          : <button type="button" className={styles.back} onClick={onBack}>‹ Rolki</button>}
        <h1>{subview === 'sources' ? 'Źródła' : 'Monitoring'}</h1>
        {subview === 'sources' ? <button type="button" className={styles.textAction} onClick={() => openForm(null)}>+ Dodaj</button>
          : <button type="button" className={styles.textAction} onClick={() => { setSubview('sources'); setForm(null); }}>Źródła</button>}
      </header>
      {offline ? <p className={styles.connection} role="status">Brak połączenia — ponawiam…</p> : null}

      {subview === 'sources' ? (
        <section className={styles.sourcesView}>
          <div className={styles.sourcesList}>
              {activeSources.length === 0 && inactiveSources.length === 0 ? <div className={styles.emptySources}>
                <p>Nie dodano jeszcze żadnych źródeł.</p><button type="button" className={styles.textAction} onClick={() => openForm(null)}>Dodaj pierwsze źródło</button>
              </div> : null}
              {allSourceGroups.map((groupLabel) => {
                const entries = activeSources.filter((source) => source.groupLabel === groupLabel);
                if (!entries.length) return null;
                return <section className={styles.sourceGroup} key={groupLabel}>
                  <h2>{groupLabel}</h2>
                  {entries.map((source) => <button type="button" className={styles.sourceRow} key={source.id} onClick={() => openForm(source)}>
                    <span className={styles.sourceFirst}><strong>{source.name}</strong><span>{PLATFORM_NAMES[source.platform]}</span></span>
                    <span className={styles.sourceSecond}><span>{source.profileUrl.replace(/^https:\/\/(?:www\.)?/i, '')}</span><span className={source.lastStatus === 'login_wall' ? styles.urgent : ''}>{sourceStatus(source)}</span></span>
                  </button>)}
                </section>;
              })}
              {inactiveSources.length ? <section className={styles.sourceGroup}>
                <h2>WYŁĄCZONE</h2>
                {inactiveSources.map((source) => <button type="button" className={`${styles.sourceRow} ${styles.inactive}`} key={source.id} onClick={() => openForm(source)}>
                  <span className={styles.sourceFirst}><strong>{source.name}</strong><span>{PLATFORM_NAMES[source.platform]}</span></span>
                  <span className={styles.sourceSecond}><span>{source.profileUrl.replace(/^https:\/\/(?:www\.)?/i, '')}</span><span>{sourceStatus(source)}</span></span>
                </button>)}
              </section> : null}
          </div>
          {form ? <aside className={styles.sourceFormPanel}><SourceForm form={form} setForm={setForm} error={formError} saving={saving} groups={allSourceGroups}
            onSave={() => void saveSource()} onCancel={() => { setForm(null); setFormError(''); }} onToggle={() => void toggleSource()} />
            {form.id ? <button type="button" className={`${styles.textAction} ${styles.toggleSource}`} disabled={saving} onClick={() => void toggleSource()}>{form.active ? 'Wyłącz źródło' : 'Włącz źródło'}</button> : null}
          </aside> : null}
        </section>
      ) : (
        <>
          <div className={styles.dayStepper}>
            <button type="button" aria-label="Poprzedni dzień" onClick={() => { onDateChange(moveDay(date, -1)); setVisibleCount(50); }}>‹</button>
            <time dateTime={date}>{dayLabel(date)}</time>
            <button type="button" aria-label="Następny dzień" disabled={date >= today()} onClick={() => { onDateChange(moveDay(date, 1)); setVisibleCount(50); }}>›</button>
          </div>
          <nav className={styles.tabs} aria-label="Widok monitoringu">
            <button type="button" aria-current={tab === 'report' ? 'page' : undefined} onClick={() => onTabChange('report')}>Raport</button>
            <button type="button" aria-current={tab === 'posts' ? 'page' : undefined} onClick={() => onTabChange('posts')}>Posty {allPosts.length}</button>
          </nav>
          {tab === 'report' ? (
            <section className={styles.reportView}>
              {report ? <div className={styles.reportMeta}>
                <span>Raport · {report.postCount} posty · {report.state === 'succeeded' ? `gotowy ${timeLabel(report.completedAt)}` : report.state === 'failed' ? 'nieudany' : 'w przygotowaniu'}</span>
                {report.synthesis ? <button type="button" className={styles.textAction} onClick={() => void copyReport()}>{copyError ? 'Nie udało się skopiować.' : 'Kopiuj raport'}</button> : null}
              </div> : null}
              {collectionProblems.length ? <>
                <button type="button" className={styles.attention} aria-expanded={collectionExpanded} onClick={() => setCollectionExpanded((value) => !value)}>
                  ⚠ {collectionProblems.length} źródła nie zebrane <span>{collectionExpanded ? '⌄' : '›'}</span>
                </button>
                {collectionExpanded ? <ul className={styles.collectionList}>
                  {collectionProblems.map((source) => <li key={source.sourceId}>
                    <span>{source.sourceName} · {source.platform === 'x' ? 'X' : 'Facebook'}</span>
                    <span className={source.status === 'login_wall' ? styles.urgent : ''}>{collectionStatus(source)}</span>
                  </li>)}
                </ul> : null}
              </> : null}
              {loading && !report ? <p className={styles.secondary}>Wczytywanie…</p> : null}
              {!report ? <div className={styles.noReport}>
                <p>Brak raportu z tego dnia.</p>
                {allPosts.length ? <button type="button" className={styles.textAction} disabled={reportBusy} onClick={() => void prepareReport()}>{reportBusy ? 'Przygotowuję…' : 'Przygotuj raport'}</button> : null}
              </div> : null}
              {report?.state === 'queued' || report?.state === 'running' ? <p className={styles.secondary}>Przygotowuję raport…</p> : null}
              {report?.state === 'failed' ? <div className={styles.reportFailure}>
                <p>Raport się nie udał.</p><button type="button" className={styles.textAction} disabled={reportBusy} onClick={() => void prepareReport()}>{reportBusy ? 'Przygotowuję…' : 'Spróbuj ponownie'}</button>
              </div> : null}
              {report?.synthesis ? <Synthesis report={report} posts={allPosts} numberByUrl={numberByUrl} onReference={openReference} /> : null}
              {report?.state === 'succeeded' && report.synthesis ? <div className={styles.regenerate}>
                <button type="button" className={styles.textAction} disabled={reportBusy} onClick={() => void prepareReport()}>{reportBusy ? 'Przygotowuję…' : 'Wygeneruj ponownie'}</button>
              </div> : null}
            </section>
          ) : (
            <section className={styles.postsView}>
              <div className={styles.filters}>
                <div className={styles.groupFilters}>
                  {['Wszystkie', ...groups].map((label) => <button key={label} type="button" aria-pressed={group === label} onClick={() => setGroup(label)}>{label}</button>)}
                </div>
                <div className={styles.platformFilters}>
                  {(['facebook', 'x'] as const).map((platform) => <button key={platform} type="button" aria-pressed={platforms[platform]}
                    onClick={() => setPlatforms((old) => ({ ...old, [platform]: !old[platform] }))}>{platform === 'facebook' ? 'FB' : 'X'}</button>)}
                </div>
              </div>
              {shownPosts.length === 0 ? <div className={styles.noPosts}>
                <p>{allPosts.length ? 'Brak postów dla tych filtrów.' : 'Brak postów z tego dnia.'}</p>
                {allPosts.length ? <button type="button" className={styles.textAction} onClick={() => { setGroup('Wszystkie'); setPlatforms({ facebook: true, x: true }); }}>Wyczyść</button> : null}
              </div> : <div className={styles.postList}>
                {shownPosts.map((post) => <PostRow key={post.id} post={post} number={numberByUrl.get(post.url) ?? 0} day={date}
                  label={labelByUrl.get(post.url)} expanded={expandedTexts.has(post.id)} highlighted={highlighted === post.id}
                  creating={reelBusy.has(post.id)} error={reelErrors.has(post.id)} onExpand={() => setExpandedTexts((old) => new Set(old).add(post.id))}
                  onCollapse={() => setExpandedTexts((old) => { const next = new Set(old); next.delete(post.id); return next; })}
                  onCreateReel={() => void createReel(post)} onOpenReel={onOpenReel} />)}
                {filteredPosts.length > shownPosts.length ? <button type="button" className={styles.showMore} onClick={() => setVisibleCount((count) => count + 50)}>Pokaż więcej</button> : null}
              </div>}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Synthesis({ report, posts, numberByUrl, onReference }: {
  report: MonitorReport; posts: MonitorPost[]; numberByUrl: Map<string, number>; onReference: (url: string) => void;
}) {
  const synthesis = report.synthesis;
  if (!synthesis) return null;
  const groupByUrl = new Map(posts.map((post) => [post.url, post.groupLabel]));
  const refs = (urls: string[]) => <span className={styles.references}>{urls.map((url, index) => <span key={`${url}-${index}`}>
    {index ? ' · ' : ''}<button type="button" onClick={() => onReference(url)}>Post {numberByUrl.get(url) ?? '?'}</button>
  </span>)}</span>;
  return <div className={styles.synthesis}>
    {synthesis.mainTopics.length ? <section className={styles.reportSection}><h2>GŁÓWNE TEMATY</h2>
      {synthesis.mainTopics.map((item, index) => <article className={styles.synthesisItem} key={`${item.topic}-${index}`}>
        <h3>{item.topic}</h3><p>{item.summary}</p>{refs(item.postUrls)}
      </article>)}</section> : null}
    {synthesis.repeatedMessaging.length ? <section className={styles.reportSection}><h2>POWTARZANE PRZEKAZY</h2>
      {synthesis.repeatedMessaging.map((item, index) => <article className={styles.synthesisItem} key={`${item.message}-${index}`}>
        <p>• „{item.message}” — {item.groups.join(', ')}</p>{refs(item.postUrls)}
      </article>)}</section> : null}
    {synthesis.groupDifferences.length ? <section className={styles.reportSection}><h2>RÓŻNICE MIĘDZY GRUPAMI</h2>
      {synthesis.groupDifferences.map((item, index) => <article className={styles.synthesisItem} key={`${item.group}-${index}`}>
        <p><strong>{item.group}</strong>  {item.description}</p>{refs(item.postUrls)}
      </article>)}</section> : null}
    {synthesis.notableQuotes.length ? <section className={styles.reportSection}><h2>CYTATY</h2>
      {synthesis.notableQuotes.map((item, index) => <article className={styles.quote} key={`${item.postUrl}-${index}`}>
        <blockquote>„{item.quote}”</blockquote><p>{LABELS[item.label]} · {groupByUrl.get(item.postUrl) ?? ''} · <button type="button" onClick={() => onReference(item.postUrl)}>Post {numberByUrl.get(item.postUrl) ?? '?'}</button></p>
      </article>)}</section> : null}
    {synthesis.videoIdeas.length ? <section className={styles.reportSection}><h2>POMYSŁY NA FILMIKI</h2>
      {synthesis.videoIdeas.map((item, index) => <article className={styles.synthesisItem} key={`${item.title}-${index}`}>
        <h3>{item.title}</h3><p>{item.angle}</p>{refs(item.postUrls)}
      </article>)}</section> : null}
  </div>;
}

function PostRow({ post, number, day, label, expanded, highlighted, creating, error, onExpand, onCollapse, onCreateReel, onOpenReel }: {
  post: MonitorPost; number: number; day: string; label?: 'fact' | 'opinion' | 'mixed'; expanded: boolean; highlighted: boolean;
  creating: boolean; error: boolean; onExpand: () => void; onCollapse: () => void; onCreateReel: () => void; onOpenReel: (id: string) => void;
}) {
  const meta = mediaLine(post);
  const textLength = post.text.length > 220;
  return <article id={`monitor-post-${post.id}`} className={`${styles.postRow} ${highlighted ? styles.highlighted : ''}`}>
    <div className={styles.postMeta}>
      <span>{number}  {post.sourceName} · {post.platform === 'x' ? 'X' : 'FB'}{post.isRepost ? ' · Repost' : ''}{post.isPinned ? ' · Przypięty' : ''} · {postDateLabel(post, day)}</span>
      {label ? <span>{LABELS[label]}</span> : null}
    </div>
    <p className={`${styles.postText} ${post.isRepost ? styles.repostText : ''} ${expanded ? styles.expandedText : ''}`}>{post.text || '—'}</p>
    {textLength ? <button type="button" className={styles.moreText} onClick={expanded ? onCollapse : onExpand}>{expanded ? 'Mniej' : 'Więcej'}</button> : null}
    {meta ? <p className={styles.postMetadata}>{meta}</p> : null}
    <div className={styles.postActions}>
      <button type="button" className={styles.textAction} onClick={() => window.open(post.url, '_blank', 'noopener,noreferrer')}>Otwórz post</button>
      {post.reelId ? <button type="button" className={styles.textAction} onClick={() => onOpenReel(post.reelId!)}>Rolka utworzona · Otwórz</button>
        : creating ? <span className={styles.secondary}>Tworzę…</span>
          : <button type="button" className={styles.textAction} onClick={onCreateReel}>Zrób rolkę</button>}
    </div>
    {error ? <p className={styles.urgent}>Nie utworzono rolki. Spróbuj ponownie.</p> : null}
  </article>;
}

function SourceForm({ form, setForm, error, saving, groups, onSave, onCancel }: {
  form: FormState; setForm: (form: FormState | null) => void; error: string; saving: boolean; groups: string[];
  onSave: () => void; onCancel: () => void; onToggle: () => void;
}) {
  const update = (changes: Partial<FormState>) => setForm({ ...form, ...changes });
  const valid = form.name.trim().length > 0 && form.name.trim().length <= 120 && form.groupLabel.trim().length > 0
    && form.groupLabel.trim().length <= 80 && validProfileUrl(form.profileUrl) && !saving;
  return <form className={styles.sourceForm} onSubmit={(event) => { event.preventDefault(); onSave(); }}>
    <label>Nazwa<input maxLength={120} value={form.name} onChange={(event) => update({ name: event.target.value })} /></label>
    <label>Grupa<input maxLength={80} value={form.groupLabel} onChange={(event) => update({ groupLabel: event.target.value })} /></label>
    {groups.length ? <div className={styles.suggestions}>{groups.map((group) => <button type="button" key={group} onClick={() => update({ groupLabel: group })}>{group}</button>)}</div> : null}
    <fieldset><legend>Platforma</legend>{form.id ? <p>{PLATFORM_NAMES[form.platform]}</p> : <div className={styles.segmented}>
      {(['facebook', 'x'] as const).map((platform) => <button type="button" key={platform} aria-pressed={form.platform === platform} onClick={() => update({ platform })}>{PLATFORM_NAMES[platform]}</button>)}
    </div>}</fieldset>
    <label>Adres profilu<input type="url" inputMode="url" maxLength={2048} placeholder="https://…" value={form.profileUrl} onChange={(event) => update({ profileUrl: event.target.value })} /></label>
    {error ? <p className={styles.urgent} role="alert">{error}</p> : null}
    <div className={styles.formActions}>
      <button type="submit" className={styles.textAction} disabled={!valid}>{saving ? 'Zapisuję…' : 'Zapisz'}</button>
      <button type="button" className={styles.textAction} onClick={onCancel}>Anuluj</button>
    </div>
  </form>;
}
