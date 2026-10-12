/**
 * Root integration check (CAPTURE-DRAFT-01 × VOICE-01): the automatic draft queued by capture is
 * an ordinary `develop` run, so it must carry the team's style examples and the v4 develop
 * prompt ID, exactly like a user-requested Opracuj, without the examples affecting its hash.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { AiService } from './ai/service.js';
import { CoreRepository, type Actor } from './core/repository.js';
import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';

const NOXAVA: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' };
const SZRON: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' };

test('a capture-triggered draft carries style examples and the same prompt ID as a user Opracuj', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    await seedUsers(db, [NOXAVA, SZRON]);
    const ai = new AiService(db);
    const core = new CoreRepository(db, (tx, actor, reel) => ai.enqueueCaptureDraft(tx, actor, reel, { enabled: true, dailyLimit: 50 }));

    // A recorded Reel with a script: an eligible style example.
    const past = await core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Stary temat', images: [] }, initialHook: 'Austriacy wymyślili Ukraińców?',
    });
    const withScript = await core.patchReel(NOXAVA, past.id, {
      operationId: randomUUID(), expectedVersion: past.version, changes: { script: 'To może Francuzi wymyślili Polaków?', status: 'to_record' },
    });
    assert.equal(withScript.status, 'to_record');

    const fresh = await core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Nowy pomysł', images: [] },
    });
    const rows = await db.query<{ prompt_id: string; input_snapshot: { styleExamples?: Array<{ reelId: string; hook: string | null }> } }>(
      "select prompt_id, input_snapshot from app.ai_runs where reel_id=$1 and trigger='capture'", [fresh.id],
    );
    assert.equal(rows.rows.length, 1);
    const examples = rows.rows[0].input_snapshot.styleExamples ?? [];
    assert.deepEqual(examples.map((example) => example.reelId), [past.id]);
    assert.equal(examples[0].hook, 'Austriacy wymyślili Ukraińców?');

    const user = await ai.enqueue(NOXAVA, past.id, {
      operationId: randomUUID(), expectedVersion: withScript.version, action: 'develop',
    });
    const userRun = await db.query<{ prompt_id: string }>('select prompt_id from app.ai_runs where id=$1', [user.id]);
    assert.equal(rows.rows[0].prompt_id, userRun.rows[0].prompt_id, 'capture draft and user Opracuj use the same develop prompt');
  } finally { await db.close(); }
});
