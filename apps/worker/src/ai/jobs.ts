import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { executeAction, type WorkRun } from './actions.js';
import { geminiClient, ProviderError } from './provider.js';
import { SourceError } from './source.js';

interface ClaimedRun extends WorkRun { lease_token: string; attempt_count: number; reel_id: string }
const MAX_ATTEMPTS = 3;

async function transaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await body(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** SKIP LOCKED makes overlapping workers claim different rows; token fences late results. */
export async function claimNext(pool: Pool): Promise<ClaimedRun | null> {
  // A process may die on its last attempt. Expired final leases must terminate,
  // not remain in "running" forever because the claim predicate excludes them.
  await pool.query(
    `update app.ai_runs set state='failed',lease_token=null,lease_expires_at=null,
       error=$1,completed_at=now()
      where state='running' and lease_expires_at<now() and attempt_count >= $2`,
    [JSON.stringify({ code: 'PROVIDER_UNAVAILABLE', message: 'Worker attempts exhausted', retryable: false }), MAX_ATTEMPTS]);
  const token = randomUUID();
  const rows = await pool.query<ClaimedRun>(
    `with chosen as (
       select id from app.ai_runs
        where ((state='queued' and next_attempt_at<=now())
          or (state='running' and lease_expires_at<now()))
          and attempt_count < $1
        order by next_attempt_at, created_at, id
        for update skip locked limit 1
     )
     update app.ai_runs r set state='running', lease_token=$2,
       lease_expires_at=now()+interval '5 minutes',attempt_count=attempt_count+1
       from chosen where r.id=chosen.id
     returning r.id,r.reel_id,r.action,r.model,r.input_snapshot,r.input_hash,r.lease_token,r.attempt_count`,
    [MAX_ATTEMPTS, token]);
  return rows.rows[0] ?? null;
}

function publicFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ProviderError) return { code: error.code, retryable: error.retryable };
  if (error instanceof SourceError) return { code: error.code, retryable: error.code === 'SOURCE_UNAVAILABLE' };
  if (error instanceof Error && error.message === 'UNSUPPORTED_INPUT') return { code: 'UNSUPPORTED_INPUT', retryable: false };
  return { code: 'INTERNAL_ERROR', retryable: true };
}

async function failRun(pool: Pool, run: ClaimedRun, error: unknown): Promise<void> {
  const failure = publicFailure(error);
  const retry = failure.retryable && run.attempt_count < MAX_ATTEMPTS;
  const backoff = Math.min(60, 5 * (2 ** (run.attempt_count - 1)));
  await pool.query(
    `update app.ai_runs set state=$3,lease_token=null,lease_expires_at=null,
       next_attempt_at=now()+($4::int * interval '1 second'),
       error=$5,completed_at=case when $3='failed' then now() else null end
      where id=$1 and state='running' and lease_token=$2 and lease_expires_at>clock_timestamp()`,
    [run.id, run.lease_token, retry ? 'queued' : 'failed', backoff,
      JSON.stringify({ code: failure.code, message: failure.code, retryable: retry })]);
}

/** Result and hook append commit together. A crashed or fenced worker cannot append twice. */
export async function finishRun(pool: Pool, run: ClaimedRun, work: { result: unknown; warnings: string[]; provenance: Record<string, unknown> }): Promise<boolean> {
  return transaction(pool, async (tx) => {
    const rows = await tx.query<{ state: string; lease_token: string | null }>(
      'select state,lease_token from app.ai_runs where id=$1 and lease_expires_at>clock_timestamp() for update', [run.id]);
    if (!rows.rows[0] || rows.rows[0].state !== 'running' || rows.rows[0].lease_token !== run.lease_token) return false;
    const reel = await tx.query<{ id: string; deleted_at: string | null }>(
      'select id,deleted_at from app.reels where id=$1 for update', [run.reel_id]);
    if (!reel.rows[0] || reel.rows[0].deleted_at) {
      await tx.query(`update app.ai_runs set state='failed',lease_token=null,lease_expires_at=null,
        error=$2,completed_at=now() where id=$1`, [run.id, JSON.stringify({ code: 'NOT_FOUND', message: 'Reel unavailable', retryable: false })]);
      return true;
    }
    const result = work.result as { hookAdditions?: string[]; memeSuggestion?: { memeId: string } | null };
    const appliedHookIds: string[] = [];
    if (result.memeSuggestion) {
      const candidate = run.input_snapshot.memeCandidates.find((item) => item.id === result.memeSuggestion!.memeId);
      const stillExists = candidate && (await tx.query<{ id: string }>('select id from app.memes where id=$1', [candidate.id])).rows[0];
      if (!stillExists) { result.memeSuggestion = null; work.warnings.push('Sugerowany mem nie jest już dostępny w bibliotece.'); }
    }
    if (['develop', 'generate_hooks'].includes(run.action)) {
      const additions = result.hookAdditions ?? [];
      if (additions.length > 3) throw new Error('INVALID_AI_RESULT');
      const positions = await tx.query<{ next_position: number }>(
        'select coalesce(max(position)+1,0)::int as next_position from app.reel_hooks where reel_id=$1', [run.reel_id]);
      let position = positions.rows[0].next_position;
      for (const text of additions) {
        const id = randomUUID();
        await tx.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,$3,\'ai\',$4)',
          [id, run.reel_id, text, position++]);
        appliedHookIds.push(id);
      }
      if (appliedHookIds.length) await tx.query('update app.reels set version=version+1,updated_at=now() where id=$1', [run.reel_id]);
    }
    const final = await tx.query(
      `update app.ai_runs set state='succeeded',lease_token=null,lease_expires_at=null,
         result=$2,provenance=$3,warnings=$4,applied_hook_ids=$5,error=null,completed_at=now()
       where id=$1 and state='running' and lease_token=$6 and lease_expires_at>clock_timestamp()`,
      [run.id, JSON.stringify(result), JSON.stringify(work.provenance), JSON.stringify(work.warnings), appliedHookIds, run.lease_token]);
    if (final.rowCount !== 1) throw new Error('AI lease expired before finalization');
    return true;
  });
}

export async function tickAi(pool: Pool, env: { GEMINI_API_KEY_FILE?: string; APP_STORAGE_ROOT?: string }): Promise<boolean> {
  const run = await claimNext(pool);
  if (!run) return false;
  try {
    if (!env.GEMINI_API_KEY_FILE || !env.APP_STORAGE_ROOT) throw new ProviderError('PROVIDER_UNAVAILABLE', false);
    const call = await geminiClient(env.GEMINI_API_KEY_FILE);
    // Strictly shorter than the five-minute lease. A stalled DNS lookup or model
    // call cannot retain ownership indefinitely; a later claim fences its token.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const work = await Promise.race([
      executeAction(run, { call, storageRoot: env.APP_STORAGE_ROOT }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new ProviderError('PROVIDER_UNAVAILABLE', true)), 240_000);
      }),
    ]).finally(() => { if (deadline) clearTimeout(deadline); });
    await finishRun(pool, run, work);
  } catch (error) {
    await failRun(pool, run, error);
  }
  return true;
}
