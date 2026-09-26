/**
 * KDRIVE-01 runtime configuration.
 *
 * All three settings or none. None means kDrive is simply not configured: the routes answer
 * PROVIDER_UNAVAILABLE `kdrive_not_configured` and nothing else in the app depends on it.
 * A partial set is a startup error, so a typo cannot silently disable the integration.
 *
 *   KDRIVE_DRIVE_ID        numeric drive id (not secret)
 *   KDRIVE_ROOT_FOLDER_ID  base folder for Reel folders (not secret)
 *   KDRIVE_TOKEN_FILE      path of a file holding the Infomaniak API token (`drive` scope)
 *
 * The token is read from the file once, at startup, and is never logged or described.
 */

import { readFileSync } from 'node:fs';

import type { KdriveSettings } from './service.js';

export interface KdriveEnv {
  KDRIVE_DRIVE_ID?: string;
  KDRIVE_ROOT_FOLDER_ID?: string;
  KDRIVE_TOKEN_FILE?: string;
}

export interface KdriveConfig extends KdriveSettings {
  token: string;
}

export class KdriveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KdriveConfigError';
  }
}

const present = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';
const NUMERIC_ID = /^\d{1,20}$/;

export function parseKdriveConfig(env: KdriveEnv, readSecret: (path: string) => string = (path) => readFileSync(path, 'utf8')): KdriveConfig | null {
  const keys = ['KDRIVE_DRIVE_ID', 'KDRIVE_ROOT_FOLDER_ID', 'KDRIVE_TOKEN_FILE'] as const;
  const set = keys.filter((key) => present(env[key]));
  if (set.length === 0) return null;
  if (set.length !== keys.length) {
    throw new KdriveConfigError(`kDrive configuration is incomplete: set all of ${keys.join(', ')} or none (missing ${keys.filter((key) => !set.includes(key)).join(', ')})`);
  }
  const driveId = env.KDRIVE_DRIVE_ID!.trim();
  const rootFolderId = env.KDRIVE_ROOT_FOLDER_ID!.trim();
  if (!NUMERIC_ID.test(driveId)) throw new KdriveConfigError('KDRIVE_DRIVE_ID must be a numeric id');
  if (!NUMERIC_ID.test(rootFolderId)) throw new KdriveConfigError('KDRIVE_ROOT_FOLDER_ID must be a numeric id');
  let token: string;
  try {
    token = readSecret(env.KDRIVE_TOKEN_FILE!.trim()).trim();
  } catch {
    // The path is configuration, not a secret; the file content never appears in a message.
    throw new KdriveConfigError(`KDRIVE_TOKEN_FILE could not be read: ${env.KDRIVE_TOKEN_FILE!.trim()}`);
  }
  if (token === '' || /\s/.test(token)) throw new KdriveConfigError('KDRIVE_TOKEN_FILE must contain exactly one token');
  return { driveId, rootFolderId, token };
}
