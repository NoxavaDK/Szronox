import { createHash, randomUUID } from 'node:crypto';
import type { AiAction, AiInputSnapshot, AiRun, ApplyAiRequest, CaptureInput, DevelopResult, FactCheckResult, ProgrammeMatch, Reel } from '@szronox/contracts';
import type { Database, Queryable } from '../db/client.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION } from '../db/client.js';
import { CoreRepository, payloadHash, type Actor } from '../core/repository.js';
import { CoreError, editConflict, idempotencyConflict, notFound, validationError } from '../core/errors.js';
import { resolveActiveRelease } from './corpus/repository.js';
import { findEvidence, MAX_EVIDENCE_CANDIDATES, type ProgrammeEvidence, searchTerms } from './corpus/retrieval.js';

const MODEL = 'gemini-3.8-flash';
// v2 (PUBLICATION-01): Opracuj without publication copy, plus generate_publication. Runs recorded
// under v1 keep their label, so old output is never attributed to the split prompts.
// v3 (HOOKS-SELECT-EDIT): Opracuj receives the selected hook as its current-hook context.
const PROMPT_ID = 'gemini-02-development-provisional-v3';
export const ACTIONS: AiAction[] = ['develop', 'generate_hooks', 'fact_check', 'language_check', 'find_programme', 'generate_publication'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stale = (code: 'STALE_FACT_CLAIM' | 'STALE_LANGUAGE_RESULT' | 'STALE_PUBLICATION_RESULT' = 'STALE_FACT_CLAIM') =>
  new CoreError({ status: 409, code, message: 'AI source changed; run a new check' });

interface ImageObject {
  id: string; storageKey: string; mimeType: string; byteSize: number; validatedAt: string;
}
export interface InternalSnapshot extends AiInputSnapshot {
  imageObjects: ImageObject[];
  programmeEvidence: ProgrammeEvidence[];
  /**
   * The corpus release this run was matched against, snapshotted so a later activation
   * cannot change what a completed run was allowed to see.
   */
  programmeReleaseId: string | null;
}
interface RunRow {
  id: string; reel_id: string; requested_by: string; action: AiAction; state: AiRun['state'];
  input_snapshot: InternalSnapshot; input_hash: string; model: string; prompt_id: string;
  prompt_stage: AiRun['promptStage']; result: AiRun['result']; provenance: Record<string, unknown>;
  warnings: string[]; error: AiRun['error']; applied_hook_ids: string[];
  application_history: ScriptEdit[];
  created_at: string; completed_at: string | null;
}

interface ScriptEdit {
  claimId: string;
  start: number;
  end: number;
  replacement: string;
  beforeHash: string;
  afterHash: string;
}

/** Replay only edits recorded by this run, verifying each full-text transition. */
function replayScriptEdits(original: string, edits: ScriptEdit[]): string | null {
  let text = original;
  const prior: ScriptEdit[] = [];
  for (const edit of edits) {
    if (hash(text) !== edit.beforeHash) return null;
    const offset = prior.filter((item) => item.end <= edit.start)
      .reduce((total, item) => total + item.replacement.length - (item.end - item.start), 0);
    if (prior.some((item) => item.start < edit.end && edit.start < item.end)) return null;
    const start = edit.start + offset;
    text = text.slice(0, start) + edit.replacement + text.slice(start + edit.end - edit.start);
    if (hash(text) !== edit.afterHash) return null;
    prior.push(edit);
  }
  return text;
}

/** Edits in the same sentence may change a claim's meaning even outside its words. */
function claimContext(source: string, start: number, end: number): { start: number; end: number } {
  const before = source.slice(0, start);
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
  const after = source.slice(end);
  const next = after.search(/[.!?\n]/);
  return { start: boundary + 1, end: next < 0 ? source.length : end + next + 1 };
}

function mappedClaimSpan(original: string, claim: FactCheckResult['claims'][number], edits: ScriptEdit[]): { start: number; end: number } | null {
  const span = claim.origin.span;
  const context = claimContext(original, span.start, span.end);
  if (edits.some((edit) => edit.start < context.end && context.start < edit.end)) return null;
  const offset = edits.filter((edit) => edit.end <= span.start)
    .reduce((total, edit) => total + edit.replacement.length - (edit.end - edit.start), 0);
  return { start: span.start + offset, end: span.end + offset };
}

function visibleSnapshot(snapshot: InternalSnapshot): AiInputSnapshot {
  const {
    imageObjects: _imageObjects, programmeEvidence: _programmeEvidence,
    programmeReleaseId: _programmeReleaseId, ...visible
  } = snapshot;
  return {
    ...visible,
    attachments: visible.attachments.map(({ storageKey: _key, ...entry }) => entry),
    memeCandidates: visible.memeCandidates.map((candidate) => ({
      ...candidate, thumbnailRef: candidate.thumbnailRef ? `/api/v1/memes/${candidate.id}/image` : null,
    })),
  };
}

const groundedPublication = (snapshot: AiInputSnapshot) =>
  snapshot.publicationContextVersion === 2 || snapshot.publicationContextVersion === 3;

function relevant(snapshot: AiInputSnapshot & { programmeReleaseId?: string | null }, action: AiAction): unknown {
  const hooks = snapshot.hooks.map(({ id, text, source, position }) => ({ id, text, source, position }));
  // PUBLICATION-01 runs remain script-only. New PUBLICATION-02 runs also depend on the
  // selected hook and exact eligible saved text. Publication target fields are guarded per
  // apply by replaceCurrentValue, so editing either target does not stale the proposal.
  if (action === 'generate_publication') {
    // v3 reads the same textual context plus the immutable original URL and capture images, so
    // its freshness is exactly v2's. Search results are evidence, not inputs.
    if (!groundedPublication(snapshot)) return { script: snapshot.script, scriptRevision: snapshot.scriptRevision };
    const selectedHook = snapshot.hooks.find((hook) => hook.id === snapshot.selectedHookId);
    return {
      script: snapshot.script, scriptRevision: snapshot.scriptRevision,
      selectedHookId: snapshot.selectedHookId ?? null, selectedHookText: selectedHook?.text ?? null,
      textualInput: {
        capturedText: snapshot.originalInput.text ?? null,
        additionalText: snapshot.originalInput.additionalText ?? null,
        originalShareTextFields: (snapshot.originalInput.originalShare?.fields ?? [])
          .filter((field) => field.name.toLowerCase() === 'text').map(({ name, value }) => ({ name, value })),
        inputNote: snapshot.inputNote,
      },
    };
  }
  if (action === 'language_check') return { script: snapshot.script, scriptRevision: snapshot.scriptRevision };
  if (action === 'fact_check') return { script: snapshot.script, hooks };
  if (action === 'find_programme') {
    return {
      script: snapshot.script, hooks,
      programmeDocumentVersionId: snapshot.programmeDocumentVersionId,
      programmeReleaseId: snapshot.programmeReleaseId ?? null,
    };
  }
  if (action === 'generate_hooks') return { originalInput: snapshot.originalInput, inputNote: snapshot.inputNote, script: snapshot.script, hooks };
  return {
    title: snapshot.title, originalInput: snapshot.originalInput, inputNote: snapshot.inputNote,
    script: snapshot.script, hooks, priority: snapshot.priority,
    attachedMemeIds: snapshot.attachedMemeIds,
    attachments: snapshot.attachments.map(({ id, state }) => ({ id, state })),
  };
}

function runResponse(row: RunRow, live: Reel): AiRun {
  const snapshot = row.input_snapshot;
  const current: AiInputSnapshot = {
    ...snapshot, title: live.title, originalInput: live.originalInput, inputNote: live.inputNote,
    script: live.script, scriptRevision: live.scriptRevision, priority: live.priority,
    selectedHookId: live.selectedHookId,
    publicationDescription: live.publicationDescription, publicationHashtags: live.publicationHashtags,
    attachedMemeIds: live.memeIds,
    hooks: live.hooks.filter((hook) => !row.applied_hook_ids.includes(hook.id))
      .map(({ id, text, source, position }) => ({ id, text, source, position })),
    attachments: live.attachments.filter((attachment) => attachment.purpose === 'input'),
  };
  const publicInput = visibleSnapshot(snapshot);
  const expectedScript = row.action === 'fact_check' ? replayScriptEdits(snapshot.script, row.application_history ?? []) : null;
  const result = row.result && row.action === 'fact_check'
    ? { ...(row.result as FactCheckResult), claims: (row.result as FactCheckResult).claims.map((claim) => {
      const hookId = claim.location.field === 'hook' ? claim.location.hookId : null;
      if (hookId !== null) {
        const original = snapshot.hooks.find((hook) => hook.id === hookId)?.text;
        const now = live.hooks.find((hook) => hook.id === hookId)?.text;
        return { ...claim, isStale: now === undefined || original === undefined || now !== original };
      }
      const mapped = mappedClaimSpan(snapshot.script, claim, row.application_history ?? []);
      return { ...claim, isStale: expectedScript === null || live.script !== expectedScript ||
        live.scriptRevision !== snapshot.scriptRevision + (row.application_history ?? []).length ||
        mapped === null || live.script.slice(mapped.start, mapped.end) !== claim.origin.span.text };
    }) }
    : row.result;
  return {
    id: row.id, reelId: row.reel_id, requestedBy: row.requested_by, action: row.action,
    state: row.state, input: publicInput, inputHash: row.input_hash,
    isStale: hash(relevant(snapshot, row.action)) !== hash(relevant(current, row.action)),
    model: row.model, promptId: row.prompt_id, promptStage: row.prompt_stage,
    result, warnings: row.warnings,
    error: row.error, appliedHookIds: row.applied_hook_ids,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  } as AiRun;
}

export class AiService {
  private readonly core: CoreRepository;
  constructor(private readonly db: Database) { this.core = new CoreRepository(db); }

  private async replay<T>(tx: Queryable, actor: Actor, operationId: string, route: string, payload: unknown): Promise<T | null> {
    const rows = await tx.query<{ actor_id: string; route: string; payload_hash: string; result: T }>(
      'select actor_id, route, payload_hash, result from app.operations where operation_id = $1', [operationId],
    );
    if (!rows.rows[0]) return null;
    if (rows.rows[0].actor_id !== actor.id || rows.rows[0].route !== route || rows.rows[0].payload_hash !== payloadHash(payload)) {
      throw idempotencyConflict();
    }
    return rows.rows[0].result;
  }

  private async record(tx: Queryable, actor: Actor, operationId: string, route: string, payload: unknown, result: unknown): Promise<void> {
    await tx.query('insert into app.operations (operation_id, actor_id, route, payload_hash, result) values ($1,$2,$3,$4,$5)',
      [operationId, actor.id, route, payloadHash(payload), JSON.stringify(result)]);
  }

  private async idempotent<T>(actor: Actor, operationId: string, route: string, payload: unknown, body: (tx: Queryable) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        const replay = await this.replay<T>(tx, actor, operationId, route, payload);
        if (replay !== null) return replay;
        const result = await body(tx);
        await this.record(tx, actor, operationId, route, payload, result);
        return result;
      });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const replay = await this.replay<T>(this.db, actor, operationId, route, payload);
        if (replay !== null) return replay;
      }
      throw error;
    }
  }

  async enqueue(actor: Actor, reelId: string, body: { operationId: string; expectedVersion: number; action: AiAction }): Promise<{ id: string; state: 'queued' }> {
    if (!ACTIONS.includes(body.action)) throw validationError('Unknown AI action');
    const payload = { reelId, ...body };
    return this.idempotent(actor, body.operationId, 'POST /reels/:id/ai-runs', payload, async (tx) => {
      const locked = await tx.query<{ version: number; original_input: CaptureInput }>(
        'select version, original_input from app.reels where id=$1 and deleted_at is null for update', [reelId]);
      if (!locked.rows[0]) throw notFound('Reel not found');
      if (locked.rows[0].version !== body.expectedVersion) throw editConflict(locked.rows[0].version);
      const reel = await this.core.loadReel(tx, reelId);
      // Checked before any image gate or provider call: the saved script is the only input.
      const publication = body.action === 'generate_publication';
      if (publication && reel.script.trim().length === 0) {
        throw validationError('A saved script is required to generate publication copy', { reason: 'script_required' });
      }
      const images = await tx.query<ImageObject & { state: string; purpose: string; validated_mime_type: string | null; validated_at: string | null }>(
        `select id, storage_key as "storageKey", coalesce(validated_mime_type, mime_type) as "mimeType",
                stored_byte_size as "byteSize", validated_at as "validatedAt", state, purpose,
                validated_mime_type, validated_at
           from app.attachments where reel_id=$1 and kind='image' and purpose='input'`, [reelId]);
      if (!publication && images.rows.some((image) => image.state !== 'ready' || !image.storageKey || !image.validated_mime_type || !image.validated_at)) {
        throw new CoreError({ status: 422, code: 'UPLOAD_INCOMPLETE', message: 'Input images must be completed and validated' });
      }
      const memes = await tx.query<{ id: string; name: string; thumbnail_ref: string | null }>(
        'select id, name, thumbnail_ref from app.memes order by name asc, id asc limit 24');
      // Resolved once, and only for the action that uses it. Every candidate below, and
      // every citation later reconstructed from them, belongs to this one release.
      const release = body.action === 'find_programme' ? await resolveActiveRelease(tx) : null;
      if (body.action === 'find_programme' && !release) {
        throw new CoreError({ status: 422, code: 'INSUFFICIENT_EVIDENCE', message: 'No active programme corpus release is available' });
      }
      const programmeEvidence: ProgrammeEvidence[] = release
        ? await findEvidence(tx, release.releaseId,
          searchTerms([reel.script, ...reel.hooks.map((hook) => hook.text)]), MAX_EVIDENCE_CANDIDATES)
        : [];
      const snapshot: InternalSnapshot = {
        reelVersion: reel.version, title: reel.title, originalInput: reel.originalInput,
        script: reel.script, scriptRevision: reel.scriptRevision,
        ...(publication ? { publicationContextVersion: 3 as const } : {}),
        hooks: reel.hooks.map(({ id, text, source, position }) => ({ id, text, source, position })),
        // Read in this same locked transaction, so it always names one of the hooks above.
        selectedHookId: reel.selectedHookId,
        inputNote: reel.inputNote, publicationDescription: reel.publicationDescription,
        publicationHashtags: reel.publicationHashtags,
        attachments: reel.attachments.filter((attachment) => attachment.purpose === 'input'),
        priority: reel.priority, attachedMemeIds: reel.memeIds,
        memeCandidateIds: memes.rows.map((meme) => meme.id),
        memeCandidates: memes.rows.map((meme) => ({ id: meme.id, name: meme.name, thumbnailRef: meme.thumbnail_ref })),
        // A release with exactly one document version names it here, which is what the
        // single-version contract field means. A multi-document release leaves it null and
        // each candidate carries its own version, because there is no single answer.
        programmeDocumentVersionId: release?.documentVersionIds.length === 1 ? release.documentVersionIds[0] : null,
        programmeReleaseId: release?.releaseId ?? null,
        // Publication (v3) reads only completed, validated capture images and never waits for
        // or fails on an incomplete upload: an image is optional grounding there.
        programmeEvidence, imageObjects: images.rows
          .filter((image) => !publication || (image.state === 'ready' && image.storageKey && image.validated_mime_type && image.validated_at))
          .map(({ id, storageKey, mimeType, byteSize, validatedAt }) => ({ id, storageKey, mimeType, byteSize, validatedAt })),
      };
      const id = randomUUID();
      const promptId = publication ? 'gemini-02-publication-provisional-v3' : PROMPT_ID;
      await tx.query(
        `insert into app.ai_runs (id,reel_id,requested_by,action,input_snapshot,input_hash,model,prompt_id,prompt_stage)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'development_provisional')`,
        [id, reelId, actor.id, body.action, JSON.stringify(snapshot), hash(relevant(snapshot, body.action)), MODEL, promptId]);
      return { id, state: 'queued' as const };
    });
  }

  async get(actor: Actor, runId: string): Promise<AiRun> {
    void actor; // Both allowlisted users have equivalent access to every Reel.
    const rows = await this.db.query<RunRow>('select * from app.ai_runs where id=$1', [runId]);
    if (!rows.rows[0]) throw notFound('AI run not found');
    const reel = await this.core.getReel(rows.rows[0].reel_id, { includeDeleted: true });
    return runResponse(rows.rows[0], reel);
  }

  async latest(actor: Actor, reelId: string, action?: AiAction): Promise<AiRun | null> {
    void actor;
    const rows = await this.db.query<RunRow>(
      `select * from app.ai_runs where reel_id=$1 and ($2::text is null or action=$2)
       order by created_at desc, id desc limit 1`, [reelId, action ?? null]);
    if (!rows.rows[0]) return null;
    return runResponse(rows.rows[0], await this.core.getReel(reelId, { includeDeleted: true }));
  }

  async apply(actor: Actor, runId: string, body: ApplyAiRequest): Promise<Reel> {
    const payload = { runId, ...body };
    return this.idempotent(actor, body.operationId, 'POST /ai-runs/:id/apply', payload, async (tx) => {
      const runs = await tx.query<RunRow>('select * from app.ai_runs where id=$1 for update', [runId]);
      const run = runs.rows[0];
      if (!run || run.state !== 'succeeded' || !run.result) throw notFound('Completed AI run not found');
      const rows = await tx.query<{ version: number; script: string; script_revision: number; title: string; priority: string; publication_description: string; publication_hashtags: string; original_input: Reel['originalInput']; input_note: string; selected_hook_id: string | null; selected_hook_text: string | null }>(
        `select r.version,r.script,r.script_revision,r.title,r.priority,r.publication_description,r.publication_hashtags,
                r.original_input,r.input_note,r.selected_hook_id,h.text as selected_hook_text
           from app.reels r left join app.reel_hooks h on h.id=r.selected_hook_id
          where r.id=$1 and r.deleted_at is null for update of r`, [run.reel_id]);
      const live = rows.rows[0];
      if (!live) throw notFound('Reel not found');
      if (live.version !== body.expectedVersion) throw editConflict(live.version);
      const input = run.input_snapshot;
      const result = run.result as Record<string, unknown>;
      if (body.selection === 'title') {
        if (run.action !== 'develop' || live.title !== input.title) throw stale();
        if (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > 300) throw validationError('Invalid title');
        await tx.query('update app.reels set title=$2,version=version+1,updated_at=now() where id=$1', [run.reel_id, body.text]);
      } else if (body.selection === 'script') {
        if (run.action !== 'develop' || live.script !== input.script) throw stale();
        if (typeof body.text !== 'string' || body.text !== (result as unknown as DevelopResult).scriptSuggestion) throw validationError('Script must match this run proposal');
        await tx.query('update app.reels set script=$2,script_revision=script_revision+case when script is distinct from $2 then 1 else 0 end,version=version+1,updated_at=now() where id=$1', [run.reel_id, body.text]);
      } else if (body.selection === 'priority') {
        const suggestion = (result as unknown as DevelopResult).prioritySuggestion;
        if (run.action !== 'develop' || !suggestion || suggestion.priority !== body.priority || live.priority !== input.priority) throw stale();
        await tx.query('update app.reels set priority=$2,version=version+1,updated_at=now() where id=$1', [run.reel_id, body.priority]);
      } else if (body.selection === 'publication_description' || body.selection === 'publication_hashtags') {
        // Legacy develop runs may still hold publication drafts; they are no longer applicable.
        if (run.action !== 'generate_publication') throw validationError('Publication copy is applied only from Wygeneruj opis', { reason: 'wrong_action' });
        if (typeof body.text !== 'string' || body.text.length > 10000) throw validationError('Invalid publication draft');
        // Text and revision: an edit-and-revert of the script also invalidates the proposal.
        const publicationLive: AiInputSnapshot = {
          ...input, script: live.script, scriptRevision: live.script_revision,
          originalInput: live.original_input, inputNote: live.input_note, selectedHookId: live.selected_hook_id,
          hooks: live.selected_hook_id === null ? input.hooks.filter((hook) => hook.id !== input.selectedHookId)
            : input.hooks.map((hook) => hook.id === live.selected_hook_id ? { ...hook, text: live.selected_hook_text ?? '' } : hook),
        };
        const changedContext = live.script !== input.script || live.script_revision !== input.scriptRevision ||
          (groundedPublication(input) && hash(relevant(input, 'generate_publication')) !== hash(relevant(publicationLive, 'generate_publication')));
        if (changedContext) throw stale('STALE_PUBLICATION_RESULT');
        const description = body.selection === 'publication_description';
        if (body.confirmReplacement !== true || typeof body.replaceCurrentValue !== 'string') {
          throw validationError('Explicit publication replacement confirmation is required');
        }
        if ((description ? live.publication_description : live.publication_hashtags) !== body.replaceCurrentValue) {
          throw editConflict(live.version);
        }
        const column = description ? 'publication_description' : 'publication_hashtags';
        await tx.query(`update app.reels set ${column}=$2,version=version+1,updated_at=now() where id=$1`, [run.reel_id, body.text]);
      } else if (body.selection === 'language_version') {
        if (run.action !== 'language_check' || live.script !== input.script || live.script_revision !== input.scriptRevision) throw stale('STALE_LANGUAGE_RESULT');
        if (!['A', 'B'].includes(body.version) || typeof body.text !== 'string' || body.text.length > 30000) {
          throw validationError('Invalid language version');
        }
        await tx.query('update app.reels set script=$2,script_revision=script_revision+case when script is distinct from $2 then 1 else 0 end,version=version+1,updated_at=now() where id=$1', [run.reel_id, body.text]);
      } else if (body.selection === 'fact_correction') {
        if (run.action !== 'fact_check') throw validationError('Wrong AI action');
        const fact = run.result as FactCheckResult;
        const claim = fact.claims.find((item) => item.id === body.claimId);
        if (!claim || !claim.correction || claim.status === 'confirmed' || claim.applied) throw stale();
        const hookId = claim.location.field === 'hook' ? claim.location.hookId : null;
        const source = hookId === null ? live.script :
          (await tx.query<{ text: string }>('select text from app.reel_hooks where id=$1 and reel_id=$2', [hookId, run.reel_id])).rows[0]?.text;
        const original = hookId === null ? input.script : input.hooks.find((hook) => hook.id === hookId)?.text;
        if (source === undefined || original === undefined) throw stale();
        const span = claim.origin.span;
        if (claim.origin.inputHash !== run.input_hash || claim.origin.reelVersion !== input.reelVersion ||
            claim.origin.sourceTextHash !== sourceHash(original) || span.offsetUnit !== 'utf16_code_units' ||
            !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 ||
            span.end <= span.start || span.end > original.length || original.slice(span.start, span.end) !== span.text) throw stale();
        if (hookId === null) {
          const edits = run.application_history ?? [];
          const expectedScript = replayScriptEdits(input.script, edits);
          const mapped = mappedClaimSpan(input.script, claim, edits);
          if (expectedScript === null || source !== expectedScript ||
              live.script_revision !== input.scriptRevision + edits.length || mapped === null ||
              source.slice(mapped.start, mapped.end) !== claim.origin.span.text ||
              claim.correction === claim.origin.span.text) throw stale();
          const changed = source.slice(0, mapped.start) + claim.correction + source.slice(mapped.end);
          await tx.query('update app.reels set script=$2,script_revision=script_revision+1,version=version+1,updated_at=now() where id=$1', [run.reel_id, changed]);
          edits.push({ claimId: claim.id, start: claim.origin.span.start, end: claim.origin.span.end,
            replacement: claim.correction, beforeHash: hash(source), afterHash: hash(changed) });
          run.application_history = edits;
        } else {
          if (source !== original || source.slice(claim.origin.span.start, claim.origin.span.end) !== claim.origin.span.text) throw stale();
          // A hook correction must retain the unrelated text around its exact span.
          if (!claim.correction.startsWith(source.slice(0, claim.origin.span.start)) ||
              !claim.correction.endsWith(source.slice(claim.origin.span.end))) throw validationError('Correction changes unrelated hook text');
          await tx.query('update app.reel_hooks set text=$2 where id=$1', [hookId, claim.correction]);
          await tx.query('update app.reels set version=version+1,updated_at=now() where id=$1', [run.reel_id]);
        }
        claim.applied = { operationId: body.operationId, reelVersion: live.version + 1, appliedAt: new Date().toISOString() };
        await tx.query('update app.ai_runs set result=$2,application_history=$3 where id=$1',
          [runId, JSON.stringify(fact), JSON.stringify(run.application_history ?? [])]);
      } else if (body.selection === 'programme_match' || body.selection === 'programme_no_match') {
        if (run.action !== 'find_programme') throw validationError('Wrong AI action');
        const current = await this.core.loadReel(tx, run.reel_id);
        if (hash(relevant(input, 'find_programme')) !== hash(relevant({ ...input, script: current.script, hooks: current.hooks }, 'find_programme'))) throw stale();
        if (body.selection === 'programme_match') {
          const candidate = (result.candidates as ProgrammeMatch[]).find((item) => item.candidateId === body.candidateId);
          if (!candidate) throw validationError('Unknown programme candidate');
          const attachment = { ...candidate, sourceRunId: runId, attachedBy: actor.id, attachedAt: new Date().toISOString() };
          await tx.query(`update app.reels set programme_state='matched',programme_attachment=$2,
            programme_input_hash=$3,programme_document_version_id=$4,version=version+1,updated_at=now() where id=$1`,
          [run.reel_id, JSON.stringify(attachment), run.input_hash, candidate.documentVersionId]);
        } else {
          if (current.programmeAttachment !== null) {
            throw validationError('Existing programme attachment is retained until explicit detach', { reason: 'programme_attached' });
          }
          await tx.query(`update app.reels set programme_state='no_match',programme_attachment=null,
            programme_input_hash=$2,programme_document_version_id=null,version=version+1,updated_at=now() where id=$1`,
          [run.reel_id, run.input_hash]);
        }
      } else throw validationError('Unknown AI selection');
      return this.core.loadReel(tx, run.reel_id);
    });
  }
}
