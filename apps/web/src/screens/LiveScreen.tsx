import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveMessage, LiveMessageStatus, LiveSignalLevel, User } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { ClientApiError } from '../data/errors.js';
import { BackArrowIcon } from '../ui/icons.js';
import '../ui/tokens.css';
import listStyles from './ReelListScreen.module.css';
import styles from './LiveScreen.module.css';

/**
 * `Na żywo` — design/live-delta-spec.md (STREAM-LIVE-01).
 *
 * Used during a broadcast, usually in a small browser window beside other work. Messages go to
 * the server and from there to StreamControl on the streaming PC; this screen only sends and
 * shows the sender's own messages. Drafts live in memory and survive a failed send.
 */

const QUOTE_MAX = 400;
const SOURCE_MAX = 120;
const REFRESH_MS = 5000;
const ENDED_VISIBLE_MS = 30_000;

const STATUS_LABEL: Record<LiveMessageStatus, string> = {
  sent: 'Wysłano', delivered: 'Dotarło', waiting: 'W kolejce', shown: 'Na ekranie', dismissed: 'Odrzucony',
  seen: 'Zobaczony', expired: 'Wygasł', replaced: 'Zastąpiony',
};
const LEVEL_LABEL: Record<LiveSignalLevel, string> = { urgent: 'Pilnie', moment: 'Gdy będzie chwila' };
const SEND_FAILED = 'Nie wysłano. Sprawdź połączenie i spróbuj ponownie.';

const time = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
const clock = (iso: string) => time.format(new Date(iso));

function failureMessage(error: unknown): string {
  if (error instanceof ClientApiError && error.status === 429) return 'Za dużo wiadomości naraz. Odczekaj chwilę.';
  return SEND_FAILED;
}

function rowLabel(message: LiveMessage): string {
  if (message.kind === 'quote') {
    const text = message.text ?? '';
    return `Cytat · „${text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text}”`;
  }
  if (message.kind === 'signal') return `Sygnał · ${LEVEL_LABEL[message.level ?? 'moment']}`;
  return 'Anulowano sygnał';
}

/** The latest signal or cancel decides the signal block's state. */
function signalState(items: readonly LiveMessage[], now: number) {
  const latest = items.find((item) => item.kind === 'signal' || item.kind === 'signal_cancel');
  if (!latest) return null;
  if (latest.kind === 'signal' && (latest.status === 'sent' || latest.status === 'delivered')) {
    return { active: true as const, message: latest };
  }
  const endedAt = new Date(latest.statusAt ?? latest.createdAt).getTime();
  if (now - endedAt > ENDED_VISIBLE_MS) return null;
  const label = latest.kind === 'signal_cancel' ? 'Anulowano' : STATUS_LABEL[latest.status];
  return { active: false as const, message: latest, label };
}

export function LiveScreen({ api, user, onBack }: { api: CoreApiClient; user: User; onBack: () => void }) {
  const [items, setItems] = useState<LiveMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [sendingQuote, setSendingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteSent, setQuoteSent] = useState(false);
  const [sendingSignal, setSendingSignal] = useState<LiveSignalLevel | 'cancel' | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  // Reused on retry, so a send that reached the server before the connection dropped is not duplicated.
  const quoteOperation = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await api.myLiveMessages();
      setItems(response.items);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoaded(true);
      setNow(Date.now());
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    let timer: number | undefined;
    const schedule = () => {
      window.clearInterval(timer);
      timer = document.visibilityState === 'visible' ? window.setInterval(() => void refresh(), REFRESH_MS) : undefined;
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); schedule(); };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  useEffect(() => {
    if (!quoteSent) return;
    const timer = window.setTimeout(() => setQuoteSent(false), 3000);
    return () => window.clearTimeout(timer);
  }, [quoteSent]);

  const trimmed = text.trim();
  const tooLong = text.length > QUOTE_MAX;
  const canSendQuote = trimmed.length > 0 && !tooLong && !sendingQuote;

  const sendQuote = async () => {
    if (!canSendQuote) return;
    quoteOperation.current ??= crypto.randomUUID();
    setSendingQuote(true);
    setQuoteError(null);
    try {
      const message = await api.sendLiveMessage({ operationId: quoteOperation.current, kind: 'quote', text: trimmed, source: source.trim() });
      quoteOperation.current = null;
      setText('');
      setSource('');
      setQuoteSent(true);
      setItems((old) => [message, ...old.filter((item) => item.id !== message.id)]);
    } catch (error) {
      setQuoteError(failureMessage(error));
    } finally {
      setSendingQuote(false);
    }
  };

  const sendSignal = async (level: LiveSignalLevel | 'cancel') => {
    setSendingSignal(level);
    setSignalError(null);
    try {
      const message = await api.sendLiveMessage(level === 'cancel'
        ? { operationId: crypto.randomUUID(), kind: 'signal_cancel' }
        : { operationId: crypto.randomUUID(), kind: 'signal', level });
      setItems((old) => [message, ...old]);
      setNow(Date.now());
    } catch (error) {
      setSignalError(failureMessage(error));
    } finally {
      setSendingSignal(null);
    }
  };

  const signal = signalState(items, now);
  const activeLevel = signal?.active ? signal.message.level : null;
  // Kuba is the recipient of signals, so only Szron sees the block (delta spec §B).
  const showSignals = user.name === 'SZRON';

  const signalButton = (level: LiveSignalLevel, label: string) => (
    <button
      type="button"
      className={`${styles.signalButton} ${level === 'urgent' ? styles.urgent : styles.moment}`}
      disabled={sendingSignal !== null}
      aria-pressed={activeLevel === level}
      onClick={() => void sendSignal(level)}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span>{sendingSignal === level ? 'Wysyłanie…' : label}{activeLevel === level ? ' ✓' : ''}</span>
    </button>
  );

  return (
    <div className={`${listStyles.screen} ${styles.live}`}>
      <header className={`${listStyles.header} ${listStyles.headerStart}`}>
        <button type="button" className={listStyles.backButton} onClick={onBack} aria-label="Wstecz"><BackArrowIcon /></button>
        <h1 className={listStyles.title}>Na żywo</h1>
      </header>
      {offline ? <p className={styles.connection} role="status">Brak połączenia — ponawiam…</p> : null}

      <div className={styles.columns}>
        <div className={styles.compose}>
          {showSignals ? (
            <section className={styles.section} aria-labelledby="live-signal">
              <h2 id="live-signal" className={styles.label}>Sygnał dla Kuby</h2>
              {signalButton('urgent', 'Pilnie chcę coś powiedzieć')}
              {signalButton('moment', 'Gdy będzie chwila')}
              {signal ? (
                <p className={styles.signalLine} role="status">
                  {signal.active ? (
                    <>
                      <span>Aktywny: {LEVEL_LABEL[signal.message.level ?? 'moment']} · {clock(signal.message.createdAt)} · {STATUS_LABEL[signal.message.status]}</span>
                      <button type="button" className={styles.textAction} disabled={sendingSignal !== null} onClick={() => void sendSignal('cancel')}>
                        {sendingSignal === 'cancel' ? 'Anulowanie…' : 'Anuluj sygnał'}
                      </button>
                    </>
                  ) : <span>{signal.label}</span>}
                </p>
              ) : null}
              {signalError ? <p className={styles.error} role="alert">{signalError}</p> : null}
            </section>
          ) : null}

          <section className={styles.section} aria-labelledby="live-quote">
            <h2 id="live-quote" className={styles.label}>Cytat na stream</h2>
            <textarea
              className={styles.quote}
              rows={4}
              placeholder="Wklej zdanie z artykułu"
              aria-label="Cytat"
              value={text}
              onChange={(event) => { setText(event.target.value); quoteOperation.current = null; setQuoteError(null); }}
            />
            <p className={`${styles.counter} ${tooLong ? styles.counterOver : ''}`} aria-live="polite">
              {tooLong ? 'Za długi · ' : ''}{text.length}/{QUOTE_MAX}
            </p>
            <input
              className={styles.source}
              placeholder="Źródło (opcjonalnie)"
              aria-label="Źródło"
              maxLength={SOURCE_MAX}
              value={source}
              onChange={(event) => { setSource(event.target.value); quoteOperation.current = null; }}
            />
            <button type="button" className={styles.sendButton} disabled={!canSendQuote} onClick={() => void sendQuote()}>
              {sendingQuote ? 'Wysyłanie…' : 'Wyślij na stream'}
            </button>
            {quoteSent ? <p className={styles.sent} role="status">Wysłano na stream</p> : null}
            {quoteError ? <p className={styles.error} role="alert">{quoteError}</p> : null}
          </section>
        </div>

        <section className={styles.history} aria-labelledby="live-sent">
          <h2 id="live-sent" className={styles.label}>Wysłane</h2>
          {loaded && items.length === 0 ? <p className={styles.empty}>Nic jeszcze nie wysłano.</p> : null}
          <ul className={styles.rows}>
            {items.map((item) => (
              <li key={item.id} className={styles.row}>
                <span className={styles.rowText}>{rowLabel(item)}</span>
                <span className={`${styles.rowStatus} ${item.status === 'shown' ? styles.statusShown : ''} ${item.status === 'dismissed' ? styles.statusMuted : ''}`}>
                  {STATUS_LABEL[item.status]} · {clock(item.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
