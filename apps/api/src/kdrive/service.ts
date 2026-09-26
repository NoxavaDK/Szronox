/**
 * KDRIVE-01: the explicit Reel ↔ kDrive folder commands behind
 * `POST|GET /api/v1/reels/:id/kdrive-folder` (T00).
 *
 * Rules this file keeps:
 *   - Folder creation happens only on an explicit request, never from capture or status.
 *   - The Reel stores `{ driveId, folderId }`, never a path (ids survive rename/move).
 *   - Create is not idempotent at kDrive (a duplicate name is rejected), so the command looks
 *     for this Reel's folder by its id tag first, and reconciles an ambiguous or duplicate
 *     create by looking again rather than creating twice.
 *   - Nothing here deletes, renames, moves or writes inside an existing kDrive folder.
 *   - A read never clears a stored reference: missing, denied and unavailable are reported and
 *     the reference is kept, so the user can relink explicitly.
 */

import type { KdriveFolderRequest, KdriveFolderResponse, KdriveFolderState, Reel } from '@szronox/contracts';

import { CoreError, editConflict, validationError } from '../core/errors.js';
import type { Actor, CoreRepository } from '../core/repository.js';
import { type KdriveClient, KdriveError, type KdriveFolder, kdriveWebUrl } from './client.js';

export interface KdriveSettings {
  driveId: string;
  /** Base folder under which Reel folders are created. */
  rootFolderId: string;
}

export interface KdriveService {
  readonly configured: boolean;
  resolve(reelId: string): Promise<KdriveFolderState>;
  command(actor: Actor, reelId: string, request: KdriveFolderRequest): Promise<KdriveFolderResponse>;
}

/** Characters kDrive (and common file systems) do not accept in a name. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_LABEL = 60;

/** The stable part of a Reel folder name. Found by suffix, so a later title change is harmless. */
export const folderTag = (reelId: string) => `[${reelId.slice(0, 8)}]`;

/** `<title or first words of the capture> [1a2b3c4d]`, cleaned for kDrive. */
export function folderName(reel: Pick<Reel, 'id' | 'title' | 'originalInput'>): string {
  const firstLine = (value: string | undefined) => (value ?? '').split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  let host = '';
  try { host = reel.originalInput.url ? new URL(reel.originalInput.url).hostname.replace(/^www\./, '') : ''; } catch { host = ''; }
  const source = reel.title.trim() || firstLine(reel.originalInput.text) || firstLine(reel.originalInput.additionalText) || host || 'Rolka';
  let label = source.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (label.length > MAX_LABEL) label = `${label.slice(0, MAX_LABEL - 1).trimEnd()}…`;
  return `${label || 'Rolka'} ${folderTag(reel.id)}`;
}

const notConfigured = () => new CoreError({
  status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: false,
  message: 'kDrive integration is not configured', details: { reason: 'kdrive_not_configured' },
});

/** A provider failure during a command, as the shared error envelope. Never carries a token. */
function commandError(error: KdriveError, context: 'create' | 'link'): CoreError {
  const details = { provider: 'kdrive', reason: error.failure, ...(error.providerCode ? { providerCode: error.providerCode } : {}) };
  if (error.failure === 'missing') {
    return new CoreError({ status: 422, code: 'PROVIDER_RESOURCE_MISSING', message: context === 'link' ? 'kDrive folder not found' : 'kDrive base folder not found', details });
  }
  if (error.failure === 'access_denied') {
    return new CoreError({ status: 502, code: 'PROVIDER_ACCESS_DENIED', message: 'kDrive refused access', details });
  }
  if (error.failure === 'unavailable') {
    return new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive is temporarily unavailable', retryable: true, details });
  }
  return new CoreError({ status: 502, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive rejected the request', details });
}

export function kdriveService(options: {
  repository: CoreRepository;
  settings: KdriveSettings | null;
  client: KdriveClient | null;
}): KdriveService {
  const { repository, settings, client } = options;
  const configured = settings !== null && client !== null;

  const isLiveFolder = (folder: KdriveFolder) => folder.type === 'dir' && folder.status === 'ok';

  async function findReelFolder(reelId: string): Promise<KdriveFolder | null> {
    const tag = folderTag(reelId);
    const children = await client!.listChildren(settings!.rootFolderId);
    return children.find((child) => isLiveFolder(child) && child.name.endsWith(tag)) ?? null;
  }

  /**
   * Find this Reel's folder under the base folder, or create it. A create that failed
   * ambiguously (timeout, 5xx) or ran into an existing name is followed by one more lookup:
   * if the folder is there it is used, never duplicated.
   */
  async function ensureFolder(reel: Reel): Promise<KdriveFolder> {
    const existing = await findReelFolder(reel.id);
    if (existing) return existing;
    const name = folderName(reel);
    try {
      return await client!.createFolder(settings!.rootFolderId, name);
    } catch (error) {
      if (!(error instanceof KdriveError) || !(error.failure === 'already_exists' || error.failure === 'unavailable')) throw error;
      const found = await findReelFolder(reel.id).catch(() => null);
      if (found) return found;
      if (error.failure === 'unavailable') throw error;
      // The name is taken by something that is not this Reel's live folder (e.g. a trashed
      // one). One distinct name, still ending with the tag so later lookups find it.
      return client!.createFolder(settings!.rootFolderId, name.replace(/ \[[0-9a-f]{8}\]$/, ' (2)$&'));
    }
  }

  function stateOf(folder: KdriveFolder): KdriveFolderState {
    return { state: 'available', driveId: settings!.driveId, folderId: folder.id, name: folder.name, webUrl: kdriveWebUrl(settings!.driveId, folder.id) };
  }

  return {
    configured,

    async resolve(reelId) {
      const reel = await repository.getReel(reelId);
      if (reel.kdriveFolder === null) return { state: 'none', configured };
      const { driveId, folderId } = reel.kdriveFolder;
      const webUrl = kdriveWebUrl(driveId, folderId);
      // A reference on another drive cannot be checked with this configuration; it is kept.
      if (!configured || driveId !== settings!.driveId) {
        return { state: configured ? 'access_denied' : 'unavailable', driveId, folderId, webUrl, retryable: !configured };
      }
      try {
        const folder = await client!.getFolder(folderId);
        if (!isLiveFolder(folder)) return { state: 'missing', driveId, folderId, webUrl, retryable: false };
        return stateOf(folder);
      } catch (error) {
        if (!(error instanceof KdriveError)) throw error;
        if (error.failure === 'missing') return { state: 'missing', driveId, folderId, webUrl, retryable: false };
        if (error.failure === 'access_denied') return { state: 'access_denied', driveId, folderId, webUrl, retryable: false };
        return { state: 'unavailable', driveId, folderId, webUrl, retryable: true };
      }
    },

    async command(actor, reelId, request) {
      const payload = request.mode === 'link'
        ? { operationId: request.operationId, expectedVersion: request.expectedVersion, mode: 'link', folderId: request.folderId }
        : { operationId: request.operationId, expectedVersion: request.expectedVersion, mode: 'create' };
      const route = `POST /reels/${reelId}/kdrive-folder`;
      // A retry of an applied command answers from the ledger, without calling kDrive again.
      const replayed = await repository.recordedOperation<KdriveFolderResponse>(request.operationId, route, payload);
      if (replayed) return replayed;

      if (!configured) throw notConfigured();
      const reel = await repository.getReel(reelId);
      if (reel.version !== request.expectedVersion) throw editConflict(reel.version);
      if (request.mode === 'create' && reel.kdriveFolder !== null) {
        throw validationError('Reel already has a kDrive folder; relink it explicitly instead', { reason: 'already_linked' });
      }

      let folder: KdriveFolder;
      try {
        if (request.mode === 'create') {
          folder = await ensureFolder(reel);
        } else {
          folder = await client!.getFolder(request.folderId);
          if (!isLiveFolder(folder)) throw validationError('The kDrive id is not an available folder', { reason: 'not_a_folder' });
        }
      } catch (error) {
        if (error instanceof KdriveError) throw commandError(error, request.mode);
        throw error;
      }

      // Version-checked again at write time. If the Reel changed meanwhile the write is
      // refused; a folder created above is found again by its tag on the next attempt.
      return repository.setKdriveFolder<KdriveFolderResponse>(actor, reelId, request, payload,
        { driveId: settings!.driveId, folderId: folder.id },
        (saved) => ({ reel: saved, folder: stateOf(folder) }));
    },
  };
}

