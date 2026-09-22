import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildStorage, ConfigError, describeConfig } from './core/config.js';
import { initializeDisposableStorageRoot } from './storage/filesystem.js';

test('filesystem storage configuration requires root/origin and bounds ticket lifetime', () => {
  assert.throws(() => buildStorage({}), (error: unknown) => error instanceof ConfigError && /APP_STORAGE_ROOT/.test(error.message));
  assert.throws(
    () => buildStorage({ APP_STORAGE_ROOT: '/private/storage' }),
    (error: unknown) => error instanceof ConfigError && /APP_ORIGIN/.test(error.message),
  );
  assert.throws(
    () => buildStorage({
      APP_STORAGE_ROOT: '/private/storage', APP_ORIGIN: 'https://szronox.test',
      APP_UPLOAD_TICKET_TTL_SECONDS: '901',
    }),
    (error: unknown) => error instanceof ConfigError && /1 to 900/.test(error.message),
  );
  assert.deepEqual(describeConfig({ APP_STORAGE_ROOT: '/private/storage' }).storage, 'filesystem');
});

test('built filesystem adapter exposes missing-root and pinned-ownership initialization failures', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-config-'));
  try {
    const missing = buildStorage({ APP_STORAGE_ROOT: path.join(parent, 'missing'), APP_ORIGIN: 'https://szronox.test' });
    await assert.rejects(missing.initialize(), /missing/);

    const root = path.join(parent, 'storage');
    await initializeDisposableStorageRoot(root);
    const storage = buildStorage({ APP_STORAGE_ROOT: root, APP_ORIGIN: 'https://szronox.test' });
    // Local tests run under a non-container uid; use the low-level constructor in
    // filesystem tests for successful I/O. This assertion proves the configured
    // adapter does not hide the pinned 1000:1000 ownership gate.
    if (process.getuid?.() === 1000 && process.getgid?.() === 1000) await storage.initialize();
    else await assert.rejects(storage.initialize(), /ownership/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
