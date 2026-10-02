import { useEffect, useRef, useState } from 'react';
import type { Meme, Reel } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from '../data/api.js';
import { AttachmentUploader } from '../data/attachments.js';
import { extractVideoPoster } from '../data/video-poster.js';
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
  const [retryingMemeId, setRetryingMemeId] = useState<string | null>(null);
  const [playingMemeId, setPlayingMemeId] = useState<string | null>(null);
  const [previewPosterUrl, setPreviewPosterUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void api.memes(query).then(({ items }) => { if (live) setItems(items); })
      .catch((error) => { if (live && !isAbandonedRequest(error)) setMessage(polishError(error)); });
    return () => { live = false; };
  }, [api, query]);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setPreviewPosterUrl(null);
    if (file && (file.type.startsWith('video/') || file.type === 'application/octet-stream' || file.type === '')) {
      void extractVideoPoster(file).then((poster) => {
        if (!live || !poster) return;
        url = URL.createObjectURL(poster);
        setPreviewPosterUrl(url);
      });
    }
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [file]);

  async function attach(memeId: string) {
    setBusy(true);
    try {
      const saved = await api.attachMeme(reel.id, { operationId: crypto.randomUUID(), expectedVersion: reel.version, memeId });
      onReel(saved); onClose();
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
    finally { setBusy(false); }
  }

  async function retryCopy(memeId: string) {
    if (retryingMemeId) return;
    setRetryingMemeId(memeId);
    try {
      const updated = await api.retryMemeCopy(memeId, { operationId: crypto.randomUUID() });
      setItems((current) => current.map((item) => item.id === memeId ? updated : item));
      const refreshed = await api.memes(query);
      setItems(refreshed.items);
    } catch (error) {
      if (!isAbandonedRequest(error)) setMessage(polishError(error) || 'Nie udało się ponowić kopii w kDrive.');
    } finally { setRetryingMemeId(null); }
  }

  async function create() {
    if (!file || !name.trim()) { setMessage('Podaj nazwę i wybierz plik.'); return; }
    const isVideo = file.type.startsWith('video/') || file.type === 'application/octet-stream' || file.type === '';
    const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (isVideo && file.size > 25 * 1024 * 1024) { setMessage('Wideo przekracza limit 25 MB.'); return; }
    if (!isVideo && (!imageTypes.includes(file.type) || file.size > 8 * 1024 * 1024)) {
      setMessage(file.size > 8 * 1024 * 1024 ? 'Zdjęcie przekracza limit 8 MB.' : 'Wybierz zdjęcie JPG, PNG, WebP lub GIF.'); return;
    }
    setBusy(true); setMessage(null);
    try {
      const uploader = new AttachmentUploader({ api });
      let posterAssetId: string | undefined;
      if (isVideo) {
        const poster = await extractVideoPoster(file);
        if (poster) {
          posterAssetId = crypto.randomUUID();
          const posterFile = new File([poster], `poster.${poster.type === 'image/jpeg' ? 'jpg' : 'webp'}`, { type: poster.type || 'image/jpeg' });
          await uploader.uploadOne({ reelId: reel.id, descriptor: { attachmentId: posterAssetId, fileName: posterFile.name, mimeType: posterFile.type, byteSize: posterFile.size }, blob: posterFile,
            purpose: 'meme', kind: 'image', operations: { initiate: crypto.randomUUID(), complete: crypto.randomUUID() } });
        }
      }
      const attachmentId = crypto.randomUUID();
      const mimeType = isVideo ? (file.type.startsWith('video/') ? file.type : 'application/octet-stream') : file.type;
      await uploader.uploadOne({ reelId: reel.id, descriptor: { attachmentId, fileName: file.name, mimeType, byteSize: file.size }, blob: file,
        purpose: 'meme', kind: isVideo ? 'video' : 'image', operations: { initiate: crypto.randomUUID(), complete: crypto.randomUUID() } });
      const current = await api.reel(reel.id);
      const created = await api.createMeme({ operationId: crypto.randomUUID(), name: name.trim(), ...(isVideo ? { videoAssetId: attachmentId, ...(posterAssetId ? { posterAssetId } : {}) } : { imageAssetId: attachmentId }),
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
        <span className={styles.fieldLabel} id="meme-file-label">Zdjęcie lub wideo</span>
        <input ref={fileInput} id="meme-file" className={styles.fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/*"
          aria-labelledby="meme-file-label" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <div className={styles.fileRow}>
          <button type="button" className={styles.secondaryButton} onClick={() => fileInput.current?.click()}>{file ? 'Zmień plik' : 'Wybierz plik'}</button>
          <span className={styles.fileName}>{file ? file.name : 'Nie wybrano pliku'}</span>
        </div>
        {file && (file.type.startsWith('video/') || file.type === 'application/octet-stream' || file.type === '') ? <div className={styles.previewVideo}>
          {previewPosterUrl ? <img src={previewPosterUrl} alt={`Podgląd wideo: ${file.name}`} /> : <span className={styles.videoPlaceholder} aria-label={`wideo ${file.name}`}>▧</span>}
          <span aria-label="wideo">▶</span></div> : null}
        <span className={styles.hint}>JPG, PNG, WebP lub GIF · Wideo do 25 MB</span>
      </div>
      <div className={styles.formActions}>
        <button type="button" className={styles.quietButton} disabled={busy} onClick={() => { setCreating(false); setMessage(null); }}>Anuluj</button>
        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void create()}>{busy ? 'Wysyłanie…' : 'Zapisz mem'}</button>
      </div>
    </> : <>
      <input aria-label="Szukaj memu" placeholder="Szukaj memu..." value={query} onChange={(event) => setQuery(event.target.value)} />
      {items.length === 0 ? <p className={styles.empty}>{query.trim() ? 'Brak memów pasujących do wyszukiwania.' : 'Biblioteka memów jest pusta.'}</p> : null}
      <div className={styles.rows}>{items.map((meme) => <div key={meme.id}>
        <div className={styles.row}>
        <button type="button" className={styles.thumbButton} disabled={busy} aria-label={meme.mediaKind === 'video' ? `Odtwórz wideo memu ${meme.name}` : `Dodaj mem ${meme.name}`}
          onClick={() => meme.mediaKind === 'video' ? setPlayingMemeId((current) => current === meme.id ? null : meme.id) : void attach(meme.id)}>
          {meme.mediaKind === 'video' && playingMemeId === meme.id
            ? <video key={meme.id} src={meme.assetRef} muted loop playsInline autoPlay aria-label={`wideo ${meme.name}`} />
            : meme.thumbnailRef ? <img src={meme.thumbnailRef} alt={meme.mediaKind === 'video' ? `wideo ${meme.name}` : ''} /> : <span className={styles.videoPlaceholder} aria-label={`wideo ${meme.name}`}>▧</span>}
          {meme.mediaKind === 'video' ? <span className={styles.playMark} aria-hidden="true">▶</span> : null}
        </button>
        <button type="button" className={styles.nameButton} disabled={busy} onClick={() => void attach(meme.id)}>{meme.name}</button>
        </div>
        {meme.kdriveCopy.state === 'copied' ? <p className={styles.copyState}>Kopia w kDrive</p>
          : meme.kdriveCopy.state === 'failed' ? <p className={styles.copyState}>Kopia w kDrive nie powiodła się · <button type="button" className={styles.copyRetry} disabled={retryingMemeId !== null} onClick={() => void retryCopy(meme.id)}>{retryingMemeId === meme.id ? 'Ponawianie…' : 'Ponów'}</button></p>
            : meme.kdriveCopy.state === 'pending' ? <p className={styles.copyState}>Kopia w kDrive · Oczekuje</p> : null}
      </div>)}</div>
      <button type="button" className={styles.addNew} onClick={() => setCreating(true)}>+ Nowy mem</button>
    </>}
  </div>;
}
