import { useEffect, useRef, useState } from 'react';
import type { Meme, Reel } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { AttachmentUploader } from '../data/attachments.js';
import { isAbandonedRequest, polishError } from '../data/errors.js';
import styles from './MemePicker.module.css';

export function MemePicker({ api, reel, onClose, onReel }:
  { api: CoreApiClient; reel: Reel; onClose: () => void; onReel: (reel: Reel) => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Meme[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void api.memes(query).then(({ items }) => { if (live) setItems(items); })
      .catch((error) => { if (live && !isAbandonedRequest(error)) setMessage(polishError(error)); });
    return () => { live = false; };
  }, [api, query]);

  async function attach(memeId: string) {
    setBusy(true);
    try {
      const saved = await api.attachMeme(reel.id, { operationId: crypto.randomUUID(), expectedVersion: reel.version, memeId });
      onReel(saved); onClose();
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!file || !name.trim()) { setMessage('Podaj nazwę i wybierz zdjęcie.'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMessage('Wybierz zdjęcie JPG, PNG lub WebP.'); return;
    }
    setBusy(true); setMessage(null);
    try {
      const attachmentId = crypto.randomUUID();
      const uploader = new AttachmentUploader({ api });
      await uploader.uploadOne({
        reelId: reel.id,
        descriptor: { attachmentId, fileName: file.name, mimeType: file.type, byteSize: file.size },
        blob: file,
        operations: { initiate: crypto.randomUUID(), complete: crypto.randomUUID() },
      });
      const current = await api.reel(reel.id);
      const created = await api.createMeme({ operationId: crypto.randomUUID(), name: name.trim(), imageAssetId: attachmentId,
        attachToReel: { reelId: reel.id, expectedVersion: current.version } });
      if (created.reel) onReel(created.reel);
      onClose();
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error) || 'Nie udało się wgrać zdjęcia. Spróbuj ponownie.'); }
    finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <header><h1>{creating ? 'NOWY MEM' : 'MEM'}</h1><button type="button" onClick={onClose} aria-label="Zamknij">×</button></header>
    {message ? <p role="status">{message}</p> : null}
    {creating ? <>
      <label>Nazwa<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {/* The native control is visually hidden: its browser-default, English presentation is
          replaced by application copy while the real input keeps the file picker accessible. */}
      <div className={styles.fileField}>
        <span className={styles.fieldLabel} id="meme-file-label">Zdjęcie</span>
        <input ref={fileInput} id="meme-file" className={styles.fileInput} type="file" accept="image/jpeg,image/png,image/webp"
          aria-labelledby="meme-file-label" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <div className={styles.fileRow}>
          <button type="button" className={styles.secondaryButton} onClick={() => fileInput.current?.click()}>{file ? 'Zmień zdjęcie' : 'Wybierz zdjęcie'}</button>
          <span className={styles.fileName}>{file ? file.name : 'Nie wybrano pliku'}</span>
        </div>
        <span className={styles.hint}>JPG, PNG lub WebP</span>
      </div>
      <div className={styles.formActions}>
        <button type="button" className={styles.quietButton} disabled={busy} onClick={() => { setCreating(false); setMessage(null); }}>Anuluj</button>
        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void create()}>{busy ? 'Wysyłanie…' : 'Zapisz mem'}</button>
      </div>
    </> : <>
      <input aria-label="Szukaj memu" placeholder="Szukaj memu..." value={query} onChange={(event) => setQuery(event.target.value)} />
      {items.length === 0 ? <p className={styles.empty}>{query.trim() ? 'Brak memów pasujących do wyszukiwania.' : 'Biblioteka memów jest pusta.'}</p> : null}
      <div className={styles.rows}>{items.map((meme) => <div key={meme.id}>
        <button type="button" disabled={busy} onClick={() => void attach(meme.id)}>
          <img src={meme.thumbnailRef ?? undefined} alt="" /><span>{meme.name}</span>
        </button>
        {meme.kdriveCopy.state === 'copied' ? <p className={styles.copyState}>Kopia w kDrive</p>
          : meme.kdriveCopy.state === 'failed' ? <p className={styles.copyState}>Kopia w kDrive nie powiodła się · Ponów</p>
            : meme.kdriveCopy.state === 'pending' ? <p className={styles.copyState}>Kopia w kDrive · Oczekuje</p> : null}
      </div>)}</div>
      <button type="button" className={styles.addNew} onClick={() => setCreating(true)}>+ Nowy mem</button>
    </>}
  </div>;
}
