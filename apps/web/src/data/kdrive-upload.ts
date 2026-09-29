import type { KdriveUploadStartRequest, KdriveUploadState, Reel } from '../../../../packages/contracts/src/index.js';
import type { CoreApiClient } from './api.js';

export interface KdriveUploadProgress { uploadId: string; completedBytes: number; totalBytes: number; phase: 'uploading' | 'finishing' | 'attaching' }
export interface KdriveUploadOptions {
  api: CoreApiClient; reel: Reel; purpose: 'video' | 'cover'; file: File; createFolder: boolean;
  existing?: KdriveUploadState; signal: AbortSignal; onProgress(progress: KdriveUploadProgress): void;
}

export class KdriveSameFileRequiredError extends Error {
  constructor() { super('Wybierz ten sam plik, aby wznowić wysyłanie.'); this.name = 'KdriveSameFileRequiredError'; }
}

/** Relay a File in bounded slices; never materializes the complete file in page memory. */
export async function uploadKdriveFile(options: KdriveUploadOptions): Promise<Reel> {
  const { api, reel, purpose, file, signal } = options;
  let upload = options.existing;
  if (upload && (upload.fileName !== file.name || upload.byteSize !== file.size || upload.mimeType !== file.type || upload.purpose !== purpose)) {
    throw new KdriveSameFileRequiredError();
  }
  if (!upload) {
    const body: KdriveUploadStartRequest = { operationId: crypto.randomUUID(), expectedVersion: reel.version,
      purpose, fileName: file.name, byteSize: file.size, mimeType: file.type, ...(options.createFolder ? { createFolder: true } : {}) };
    upload = await api.startKdriveUpload(reel.id, body);
  }
  const state = upload;
  const totalChunks = Math.ceil(file.size / state.chunkSize);
  if (totalChunks !== state.totalChunks) throw new KdriveSameFileRequiredError();
  let completedBytes = state.receivedChunks.reduce((sum, index) => sum + Math.min(state.chunkSize, file.size - index * state.chunkSize), 0);
  options.onProgress({ uploadId: state.uploadId, completedBytes, totalBytes: file.size, phase: 'uploading' });
  for (let index = 0; index < totalChunks; index += 1) {
    if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    // Re-send chunk zero on resume: the server compares its saved digest to prove identity.
    if (state.receivedChunks.includes(index) && index !== 0) continue;
    const begin = index * state.chunkSize;
    const slice = file.slice(begin, Math.min(file.size, begin + state.chunkSize));
    await api.sendKdriveChunk(state.uploadId, index, slice, signal);
    if (!state.receivedChunks.includes(index)) completedBytes += slice.size;
    options.onProgress({ uploadId: state.uploadId, completedBytes, totalBytes: file.size, phase: 'uploading' });
  }
  options.onProgress({ uploadId: state.uploadId, completedBytes: file.size, totalBytes: file.size, phase: 'finishing' });
  await api.finishKdriveUpload(state.uploadId);
  options.onProgress({ uploadId: state.uploadId, completedBytes: file.size, totalBytes: file.size, phase: 'attaching' });
  const current = await api.reel(reel.id);
  return api.attachKdriveUpload(state.uploadId, { operationId: crypto.randomUUID(), expectedVersion: current.version });
}

export function uploadPercent(progress: Pick<KdriveUploadProgress, 'completedBytes' | 'totalBytes'>): number {
  return progress.totalBytes === 0 ? 0 : Math.min(100, Math.floor(progress.completedBytes / progress.totalBytes * 100));
}
