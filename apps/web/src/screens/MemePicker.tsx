import { useEffect, useState } from 'react';
import type { Meme, Reel } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
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
    setBusy(true); setMessage(null);
    try {
      const attachmentId = crypto.randomUUID();
      const initiated = await api.initiateAttachment(reel.id, {
        operationId: crypto.randomUUID(), attachmentId, fileName: file.name,
        mimeType: file.type, byteSize: file.size, purpose: 'material',
      });
      const transport = new URL(initiated.upload.uploadUrl, location.origin);
      if (transport.origin !== location.origin) throw new Error('CROSS_ORIGIN_UPLOAD');
      await api.uploadAttachmentContent(transport.pathname + transport.search, file, {
        method: initiated.upload.method, headers: initiated.upload.headers,
      });
      await api.completeAttachment(reel.id, attachmentId, { operationId: crypto.randomUUID() });
      const current = await api.reel(reel.id);
      const created = await api.createMeme({ operationId: crypto.randomUUID(), name: name.trim(), imageAssetId: attachmentId,
        attachToReel: { reelId: reel.id, expectedVersion: current.version } });
      if (created.reel) onReel(created.reel);
      onClose();
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
    finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <header><h1>{creating ? 'NOWY MEM' : 'MEM'}</h1><button type="button" onClick={onClose} aria-label="Zamknij">×</button></header>
    {message ? <p role="status">{message}</p> : null}
    {creating ? <>
      <label>Nazwa<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Zdjęcie<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <button type="button" disabled={busy} onClick={() => void create()}>Zapisz</button>
    </> : <>
      <input aria-label="Szukaj memu" placeholder="Szukaj memu..." value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className={styles.rows}>{items.map((meme) => <button key={meme.id} type="button" disabled={busy} onClick={() => void attach(meme.id)}>
        <img src={meme.thumbnailRef ?? undefined} alt="" /><span>{meme.name}</span>
      </button>)}</div>
      <button type="button" onClick={() => setCreating(true)}>+ NOWY MEM</button>
    </>}
  </div>;
}
