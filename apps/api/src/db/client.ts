/**
 * Database access boundary.
 *
 * Repositories depend only on `Queryable` and `Database`, never on a concrete
 * driver. Two adapters satisfy them:
 *
 *   - PGlite (real PostgreSQL compiled to WASM) for tests, so migrations, CHECK
 *     constraints, transactions and rollback are genuinely exercised without a
 *     server. It is honest evidence for everything a single session can show.
 *   - node-postgres for a real server, where multi-connection behaviour applies.
 *
 * Known limit, stated because it bounds what the test suite can prove: PGlite is
 * single-connection. A genuine race between two sessions on the same row cannot
 * be demonstrated against it. Compare-and-update is therefore written so its
 * correctness does not depend on application-level sequencing — the guard lives in
 * the UPDATE's own WHERE clause — and the suite asserts the interleaving it can
 * actually produce. See docs/implementation/T05-result.md.
 */

export interface QueryResult<Row> {
  rows: Row[];
  /** Rows affected, where the driver reports it. */
  rowCount: number;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  /**
   * Run a multi-statement SQL script with no parameters.
   *
   * Separate from `query` because the two drivers differ: PGlite's `query` uses the
   * extended protocol and accepts exactly one statement, while a migration file is
   * a script. Keeping this explicit means a migration runs as the committed SQL
   * rather than being split up and reassembled by this layer.
   */
  execScript(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /**
   * Run `body` inside a single transaction. Commits on return, rolls back on
   * throw. Nested calls are rejected rather than silently flattened, because a
   * "transaction" that is actually a savepoint-free no-op would make rollback
   * tests pass for the wrong reason.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres error codes this layer needs to recognise. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export function pgErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/** Minimal shape of a PGlite instance, so this module need not import its types. */
interface PGliteLike {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Wrap PGlite as a `Database`.
 *
 * Because PGlite serialises everything onto one connection, the transaction
 * helper guards against re-entry: two overlapping `transaction()` calls would
 * otherwise interleave their BEGIN/COMMIT on the same session and corrupt both.
 */
export function pgliteDatabase(instance: PGliteLike): Database {
  let inTransaction = false;

  const query = async <Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> => {
    const result = await instance.query<Row>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const execScript = async (sql: string): Promise<void> => { await instance.exec(sql); };

  return {
    query,
    execScript,
    async transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
      if (inTransaction) {
        throw new Error('pglite: nested transaction on a single connection is not supported');
      }
      inTransaction = true;
      await instance.exec('BEGIN');
      try {
        const value = await body({ query, execScript });
        await instance.exec('COMMIT');
        return value;
      } catch (error) {
        await instance.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close: () => instance.close(),
  };
}

/** Minimal shape of a node-postgres pool, kept dependency-free here. */
interface PgPoolLike {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<{
    query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

/**
 * Wrap a node-postgres pool as a `Database`. Each transaction takes its own
 * connection, so concurrent transactions genuinely run against separate sessions.
 * `pg` is not a dependency of this package; the pool is injected by whoever
 * composes the server.
 */
export function pgPoolDatabase(pool: PgPoolLike): Database {
  return {
    async query<Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
      const result = await pool.query<Row>(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    // node-postgres runs a parameterless multi-statement string in simple query mode.
    async execScript(sql: string): Promise<void> { await pool.query(sql); },
    async transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const value = await body({
          query: async <Row>(sql: string, params: unknown[] = []) => {
            const result = await connection.query<Row>(sql, params);
            return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
          },
          execScript: async (script: string) => { await connection.query(script); },
        });
        await connection.query('COMMIT');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}
