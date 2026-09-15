/*
 * Controlled overlap for the real PostgreSQL harness.
 *
 * The problem with the previous harness
 * -------------------------------------
 * It launched two repository calls with `Promise.all` on independent pools and asserted
 * that exactly one won. That is a real outcome, but it is not evidence of a race: the
 * two transactions may have run one after the other, microseconds apart, and produced
 * the identical result. Distinct connections prove the writers *could* overlap; they do
 * not prove they *did*. Certifying concurrency safety on that basis would be certifying
 * a coincidence.
 *
 * What this adds
 * --------------
 * A latch inside the transaction, and an independent observer that confirms the second
 * writer is genuinely blocked on the first before anything is released.
 *
 *   1. `barrierDatabase` wraps a `Database` and lets the caller pause a transaction
 *      *after* a chosen statement, with the transaction still open and its locks still
 *      held. It wraps only the `Queryable` handed to the body, so the repository under
 *      test is the real production class running its real statements.
 *   2. The observer connection asks PostgreSQL `pg_blocking_pids(<second writer>)`. A
 *      non-empty result containing the first writer's backend pid is the server's own
 *      statement that the two sessions are contending for the same lock at the same
 *      instant.
 *   3. Only then is the first writer released.
 *
 * If the blocking relationship is never observed within the deadline, `awaitBlockedBy`
 * throws. A harness that cannot demonstrate the overlap must fail rather than fall back
 * to the weaker assertion, because the weaker assertion is what was wrong before.
 *
 * Nothing here is a substitute for the real gate: it needs a real PostgreSQL server and
 * runs at VPS-06.
 */

/** A promise plus its resolver, so a transaction can be paused from outside. */
export function latch() {
  let release;
  let reached;
  const released = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  return { released, arrived, release: () => release(), reach: (value) => reached(value) };
}

/**
 * Wrap a `Database` so one transaction can be paused mid-flight.
 *
 * `hooks.afterStatement(sql, result, tx)` runs after every statement the body issues
 * inside a transaction. Returning a promise pauses the transaction there — which is the
 * whole point: the transaction stays open, so its row locks stay held.
 *
 * Only `transaction` is intercepted. Plain `query` calls outside a transaction are
 * passed through untouched, so the wrapper cannot change the behaviour it is observing.
 */
export function barrierDatabase(db, hooks) {
  return {
    query: (sql, params) => db.query(sql, params),
    execScript: (sql) => db.execScript(sql),
    close: () => db.close(),
    transaction(body) {
      return db.transaction(async (tx) => body({
        execScript: (sql) => tx.execScript(sql),
        async query(sql, params) {
          const result = await tx.query(sql, params);
          if (hooks.afterStatement) await hooks.afterStatement(sql, result, tx);
          return result;
        },
      }));
    },
  };
}

/** The backend pid of the session a transaction is running on. */
export async function backendPid(tx) {
  const result = await tx.query('select pg_backend_pid()::int as pid');
  return result.rows[0].pid;
}

/**
 * Wait until PostgreSQL reports `blockedPid` as waiting on `blockerPid`.
 *
 * `pg_blocking_pids` is the authoritative answer: it lists the sessions whose locks a
 * given session is waiting for. Polling is bounded, and a timeout is a failure — an
 * unobserved overlap means the test did not demonstrate what it claims, whatever the
 * final outcome of the two writes turns out to be.
 */
export async function awaitBlockedBy(observer, blockedPid, blockerPid, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastSeen = null;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `select pg_blocking_pids($1)::int[] as blockers,
              (select wait_event_type from pg_stat_activity where pid = $1) as wait_event_type,
              (select wait_event from pg_stat_activity where pid = $1) as wait_event,
              (select state from pg_stat_activity where pid = $1) as state`,
      [blockedPid],
    );
    const row = result.rows[0];
    lastSeen = row;
    if (Array.isArray(row.blockers) && row.blockers.includes(blockerPid)) {
      return {
        blockedPid,
        blockerPid,
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        state: row.state,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `controlled overlap was not demonstrated: pid ${blockedPid} was never reported as blocked by ${blockerPid} `
    + `(last observed: ${JSON.stringify(lastSeen)}). This run proves nothing about concurrency.`,
  );
}

/**
 * Run two writers with a proven overlap at one statement.
 *
 * `firstWriter` is paused after the statement matched by `pauseAfter`, with its
 * transaction open. `secondWriter` is then started and must block; the observer confirms
 * it, the first writer is released, and both settled results are returned along with the
 * evidence of the overlap.
 *
 * The caller asserts the outcome. This function's only job is to guarantee that the
 * outcome was produced by a real, observed contention.
 */
export async function withProvenOverlap({
  firstDatabase,
  secondDatabase,
  observer,
  pauseAfter,
  firstWriter,
  secondWriter,
  timeoutMs,
}) {
  const hold = latch();
  let firstPid = null;
  let paused = false;

  const wrappedFirst = barrierDatabase(firstDatabase, {
    async afterStatement(sql, result, tx) {
      if (firstPid === null) firstPid = await backendPid(tx);
      // Pause once, at the chosen statement. Pausing again would hold a lock the
      // second writer is no longer waiting for and could deadlock the harness.
      if (!paused && pauseAfter(sql, result)) {
        paused = true;
        hold.reach({ pid: firstPid });
        await hold.released;
      }
    },
  });

  let secondPid = null;
  const wrappedSecond = barrierDatabase(secondDatabase, {
    async afterStatement(_sql, _result, tx) {
      if (secondPid === null) secondPid = await backendPid(tx);
    },
  });

  const firstSettled = firstWriter(wrappedFirst).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );

  // Wait for the first writer to actually be inside its transaction holding the lock.
  // Starting the second writer before that would be the same unproven interleaving the
  // previous harness had.
  await Promise.race([
    hold.arrived,
    firstSettled.then(() => { throw new Error('the first writer completed before reaching the pause point'); }),
  ]);

  const secondSettled = secondWriter(wrappedSecond).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );

  // The second writer's pid is only known once its transaction has issued a statement.
  const pidDeadline = Date.now() + (timeoutMs ?? 10_000);
  while (secondPid === null) {
    if (Date.now() > pidDeadline) throw new Error('the second writer never issued a statement');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  let overlap;
  try {
    overlap = await awaitBlockedBy(observer, secondPid, firstPid, { timeoutMs });
  } finally {
    // Released even on failure, so a harness error does not leave a transaction open
    // holding locks against the development database.
    hold.release();
  }

  return { overlap, first: await firstSettled, second: await secondSettled };
}
