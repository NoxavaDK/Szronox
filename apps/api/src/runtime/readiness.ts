/**
 * Liveness and readiness are different questions.
 *
 * `/api/v1/health` answers "is this process running and serving HTTP?". The scaffold
 * app answers it too, with no database, no storage and no roster — which is exactly
 * why a healthy response has never been evidence that the application works.
 *
 * `/api/v1/ready` answers "can this process serve authenticated application traffic
 * right now?". It is 503 until composition succeeded, 503 again if a dependency later
 * stops answering, and it never reports ready on the strength of a value cached at
 * startup: the database and the roster are re-checked, with a bound, on every call.
 *
 * The distinction matters operationally: the Compose healthcheck and any future load
 * balancer must watch readiness, or a process that lost its database stays in
 * rotation because its HTTP stack is fine.
 */

import { access, constants } from 'node:fs/promises';
import path from 'node:path';

import type { Database } from '../db/client.js';

export type ReadinessPhase = 'starting' | 'ready' | 'failed' | 'stopping';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  phase: ReadinessPhase;
  /** Machine-readable cause when not ready. Never a driver message or a secret. */
  reason: string | null;
  checks: Record<string, 'pass' | 'fail' | 'skipped'>;
}

export interface ReadinessProbe {
  /** Cheap, bounded live check. Throws to mean "not ready". */
  check(): Promise<void>;
}

export interface ReadinessTracker {
  phase(): ReadinessPhase;
  markReady(): void;
  markFailed(reason: string): void;
  markStopping(): void;
  report(): Promise<ReadinessReport>;
}

/**
 * The scaffold's tracker: permanently not ready, and honest about why.
 *
 * Used when `buildApp()` is called with no runtime, so a scaffold process cannot be
 * mistaken for a configured one by anything that asks the right question.
 */
export function unconfiguredReadiness(reason = 'runtime_not_configured'): ReadinessTracker {
  return {
    phase: () => 'failed',
    markReady() { throw new Error('the unconfigured readiness tracker cannot become ready'); },
    markFailed() { /* already failed */ },
    markStopping() { /* nothing to stop */ },
    async report() {
      return { status: 'not_ready', phase: 'failed', reason, checks: { composition: 'fail' } };
    },
  };
}

export interface RuntimeReadinessOptions {
  db: Database;
  /** The two configured identities, compared against the database on every probe. */
  expectedUsers: ReadonlyArray<{ id: string; name: 'NOXAVA' | 'SZRON' }>;
  probes?: Record<string, ReadinessProbe>;
  /** Upper bound for the whole probe set, so /ready cannot hang behind a stuck query. */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function runtimeReadiness(options: RuntimeReadinessOptions): ReadinessTracker {
  const timeoutMs = options.timeoutMs ?? 2_000;
  let phase: ReadinessPhase = 'starting';
  let failureReason: string | null = null;

  /**
   * One statement for both facts, so the roster and the connection are observed in
   * the same snapshot: a database that answers but has lost a user is not ready.
   */
  async function rosterCheck(): Promise<void> {
    const result = await options.db.query<{ id: string; name: 'NOXAVA' | 'SZRON'; has_credential: boolean }>(
      `select u.id, u.name, (c.user_id is not null) as has_credential
         from app.users u
         left join app.user_credentials c on c.user_id = u.id
        order by u.name`,
    );
    if (result.rows.length !== 2) throw new Error(`roster has ${result.rows.length} users`);
    for (const expected of options.expectedUsers) {
      const row = result.rows.find((candidate) => candidate.name === expected.name);
      if (!row) throw new Error(`${expected.name} is missing`);
      if (row.id !== expected.id) throw new Error(`${expected.name} id does not match configuration`);
      if (!row.has_credential) throw new Error(`${expected.name} has no credential`);
    }
  }

  return {
    phase: () => phase,
    markReady() { if (phase !== 'stopping') { phase = 'ready'; failureReason = null; } },
    markFailed(reason) { if (phase !== 'stopping') { phase = 'failed'; failureReason = reason; } },
    markStopping() { phase = 'stopping'; failureReason = 'shutting_down'; },

    async report(): Promise<ReadinessReport> {
      const checks: Record<string, 'pass' | 'fail' | 'skipped'> = {};
      if (phase !== 'ready') {
        // Nothing is probed while starting, failed or stopping: a live probe would
        // be a second answer to a question already settled, and probing during
        // shutdown would re-open a pool that is being drained.
        for (const name of ['roster', ...Object.keys(options.probes ?? {})]) checks[name] = 'skipped';
        return {
          status: 'not_ready',
          phase,
          reason: failureReason ?? (phase === 'starting' ? 'starting' : 'not_ready'),
          checks,
        };
      }

      let reason: string | null = null;
      try {
        await withTimeout(rosterCheck(), timeoutMs, 'roster check');
        checks.roster = 'pass';
      } catch (error) {
        checks.roster = 'fail';
        reason = error instanceof Error ? error.message : 'roster check failed';
      }
      for (const [name, probe] of Object.entries(options.probes ?? {})) {
        if (reason !== null) { checks[name] = 'skipped'; continue; }
        try {
          await withTimeout(probe.check(), timeoutMs, `${name} check`);
          checks[name] = 'pass';
        } catch (error) {
          checks[name] = 'fail';
          reason = error instanceof Error ? error.message : `${name} check failed`;
        }
      }
      return reason === null
        ? { status: 'ready', phase, reason: null, checks }
        : { status: 'not_ready', phase, reason, checks };
    },
  };
}

/**
 * A live check that the private storage root is still there and still writable.
 *
 * Deliberately not `storage.initialize()`: that call memoises its result, so after
 * the first success it would answer from cache and a volume that disappeared later
 * would still look healthy. Deep validation — ownership, modes, same-filesystem,
 * fsync — is the adapter's job and runs once before the process starts listening.
 * This only answers the question that can change afterwards: can we still write
 * there. An unmounted, remounted-read-only or permission-changed volume fails here.
 */
export function storageRootProbe(root: string): ReadinessProbe {
  return {
    async check() {
      const required = constants.R_OK | constants.W_OK | constants.X_OK;
      await access(root, required);
      await Promise.all([
        access(path.join(root, 'staging'), required),
        access(path.join(root, 'objects'), required),
      ]);
    },
  };
}
