/** Best-effort first-frame poster extraction. A failed browser decoder never blocks meme creation. */
export async function extractVideoPoster(file: File, timeoutMs = 5_000): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = objectUrl;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('poster_timeout')), remaining());
      const cleanup = () => { window.clearTimeout(timer); video.removeEventListener('loadedmetadata', onReady); video.removeEventListener('error', onError); };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('poster_decode_failed')); };
      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
      if (video.readyState >= 1) onReady();
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) return null;
    const seekTo = Math.min(0.1, video.duration / 2);
    if (Math.abs(video.currentTime - seekTo) > 0.001) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('poster_timeout')), remaining());
        const cleanup = () => { window.clearTimeout(timer); video.removeEventListener('seeked', onSeek); video.removeEventListener('error', onError); };
        const onSeek = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('poster_decode_failed')); };
        video.addEventListener('seeked', onSeek, { once: true });
        video.addEventListener('error', onError, { once: true });
        video.currentTime = seekTo;
      });
    }
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    if (!video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) { resolve(blob); return; }
        canvas.toBlob((fallback) => resolve(fallback), 'image/jpeg', 0.86);
      }, 'image/webp', 0.86);
    });
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
