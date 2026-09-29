import { buildStorage, type CoreEnv } from '../core/config.js';
import { parseKdriveConfig } from './config.js';
import { httpKdriveClient } from './client.js';
import { createMemeCopyService } from './meme-copy.js';
import { openDatabase, type DatabaseEnv } from '../runtime/database.js';

/** Explicit one-off operator command for existing library rows; never runs at API startup. */
export async function copyExistingMemes(env: CoreEnv & DatabaseEnv = process.env as CoreEnv & DatabaseEnv) {
  const config = parseKdriveConfig(env);
  if (!config) throw new Error('kDrive is not configured');
  const database = await openDatabase(env, { poolMax: 2, applicationName: 'szronox-copy-memes' });
  const storage = buildStorage(env);
  try {
    await storage.initialize();
    const service = createMemeCopyService({ db: database.db, storage, config,
      folders: httpKdriveClient({ driveId: config.driveId, token: config.token }) });
    return await service.copyExistingPending();
  } finally { await database.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void copyExistingMemes().then((result) => {
    process.stdout.write(`Meme copies selected: ${result.selected}; copied: ${result.copied}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Meme copy command failed'}\n`);
    process.exitCode = 1;
  });
}
