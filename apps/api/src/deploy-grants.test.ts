/**
 * The deployment's SQL, executed.
 *
 * VPS-04 left one question open and said so: `grants.sql` and the `initdb` role script
 * had never been run, so whether they produce the privileges
 * `runtime/privileges.ts` demands was unknown. If they do not, the API and the worker
 * refuse to start — meaning the deployment fails at the last step, after the database is
 * already provisioned, with a message about grants nobody can fix without a second pass.
 *
 * This closes that question without a container. PGlite is real PostgreSQL 18, and it
 * supports `CREATE ROLE`, `GRANT`, `REVOKE`, `pg_roles` and `has_table_privilege(role,
 * table, privilege)`. So the committed deployment files are read from disk, executed in
 * the documented order — roles, then migrations, then grants — and the resulting privilege
 * state is read back out of the catalog and fed through the *production* refusal rules.
 *
 * Read from disk, not restated: if somebody edits `grants.sql`, this test executes the
 * edit. A copy of the SQL inlined here would only ever prove the copy correct.
 *
 * What this does NOT establish, and must not be read as establishing:
 *
 *   - **Authentication as those roles.** PGlite has no server and no login; the roles are
 *     created and their grants are real, but nothing connects *as* `szronox_api`. That
 *     `DATABASE_USER=szronox_api` with the mounted password actually logs in is a VPS-05
 *     gate.
 *   - **The shell script's execution.** The role SQL is extracted from
 *     `10-runtime-roles.sh` and run directly. psql's `:'var'` quoting, the secret-file
 *     reads and Docker's `docker-entrypoint-initdb.d` behaviour are not exercised here.
 *   - **PostgreSQL 17.6.** The deployment pins 17.6; PGlite is 18. Grant semantics are
 *     stable across both, but the version difference is real.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { pgliteDatabase, type Database } from './db/client.js';
import { migrate } from './db/migrate.js';
import {
  apiPrivilegeViolations,
  readRoleFacts,
  workerPrivilegeViolations,
  type RoleFacts,
} from './runtime/privileges.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/ -> apps/api -> apps -> repository root */
const repositoryRoot = path.resolve(here, '../../..');
const deployDirectory = path.join(repositoryRoot, 'deploy', 'vps', 'postgres');

const RUNTIME_ROLES = ['szronox_api', 'szronox_worker'] as const;
const WATCHED_TABLES = ['app.users', 'app.user_credentials', 'app.auth_sessions', 'app.reels'] as const;

/**
 * Pull the SQL out of the initdb script's heredoc.
 *
 * The script is shell, so it cannot be executed against PGlite directly. Extracting the
 * heredoc keeps the committed file as the single source: a change to the SQL is a change
 * to what this test runs, and a change to the heredoc markers makes the extraction fail
 * loudly rather than silently testing nothing.
 */
export function extractHeredocSql(script: string): string {
  const start = script.indexOf("<<'SQL'");
  assert.notEqual(start, -1, "the initdb script must contain a <<'SQL' heredoc");
  const body = script.slice(script.indexOf('\n', start) + 1);
  const end = body.search(/^SQL$/m);
  assert.notEqual(end, -1, 'the initdb heredoc must be terminated by a bare SQL line');
  const sql = body.slice(0, end);
  assert.ok(sql.includes('create role szronox_api'), 'the extracted SQL must create the API role');
  assert.ok(sql.includes('create role szronox_worker'), 'the extracted SQL must create the worker role');
  return sql;
}

/**
 * Substitute psql's client-side variables.
 *
 * `:'name'` interpolates a quoted literal and `:"name"` a quoted identifier. Only these
 * two forms appear in the script; anything else left behind would be a syntax error, and
 * the assertion below makes that a test failure rather than a confusing SQL error.
 */
function applyPsqlVariables(sql: string, variables: Record<string, string>): string {
  let applied = sql;
  for (const [name, value] of Object.entries(variables)) {
    applied = applied
      .replaceAll(`:'${name}'`, `'${value.replaceAll("'", "''")}'`)
      .replaceAll(`:"${name}"`, `"${value.replaceAll('"', '""')}"`);
  }
  assert.ok(!/:['"]\w+['"]/.test(applied), `unsubstituted psql variable remains: ${applied.match(/:['"]\w+['"]/)?.[0]}`);
  return applied;
}

interface Provisioned {
  db: Database;
  raw: PGlite;
  close(): Promise<void>;
}

/** Roles, then migrations, then grants — the order the runbook and Compose both use. */
async function provisionDatabase(): Promise<Provisioned> {
  const raw = await PGlite.create();
  const db = pgliteDatabase(raw);

  const roleScript = await readFile(path.join(deployDirectory, 'initdb', '10-runtime-roles.sh'), 'utf8');
  const databaseName = (await db.query<{ name: string }>('select current_database() as name')).rows[0].name;
  await raw.exec(applyPsqlVariables(extractHeredocSql(roleScript), {
    // Synthetic, and never used to connect: PGlite has no login path.
    api_password: 'synthetic-api-role-password',
    worker_password: 'synthetic-worker-role-password',
    dbname: databaseName,
  }));

  await migrate(db);

  const grants = await readFile(path.join(deployDirectory, 'grants.sql'), 'utf8');
  await raw.exec(grants);

  return { db, raw, close: () => raw.close() };
}

/** Read the real catalog for a role that is not the connected one. */
async function factsFor(db: Database, role: string): Promise<RoleFacts> {
  const summary = await db.query<{
    is_superuser: boolean; can_create_db: boolean; can_create_role: boolean;
    can_create_schema: boolean; can_use_schema: boolean;
  }>(
    `select rolsuper as is_superuser,
            rolcreatedb as can_create_db,
            rolcreaterole as can_create_role,
            pg_catalog.has_schema_privilege($1, 'app', 'CREATE') as can_create_schema,
            pg_catalog.has_schema_privilege($1, 'app', 'USAGE') as can_use_schema
       from pg_roles where rolname = $1`,
    [role],
  );
  assert.equal(summary.rows.length, 1, `${role} must exist after the initdb script`);
  const row = summary.rows[0];
  assert.equal(row.can_use_schema, true, `${role} must have USAGE on schema app`);

  const privileges: RoleFacts['privileges'] = {};
  for (const table of WATCHED_TABLES) {
    const grant = await db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
      `select pg_catalog.has_table_privilege($1, $2, 'SELECT') as s,
              pg_catalog.has_table_privilege($1, $2, 'INSERT') as i,
              pg_catalog.has_table_privilege($1, $2, 'UPDATE') as u,
              pg_catalog.has_table_privilege($1, $2, 'DELETE') as d`,
      [role, table],
    );
    const found = grant.rows[0];
    privileges[table] = { select: found.s, insert: found.i, update: found.u, delete: found.d };
  }

  return {
    role,
    isSuperuser: row.is_superuser === true,
    canCreateDb: row.can_create_db === true,
    canCreateRole: row.can_create_role === true,
    canCreateInAppSchema: row.can_create_schema === true,
    privileges,
  };
}

// ══════════════════════ the deployment SQL applies ══════════════════════════

test('the initdb role script and grants.sql apply in the documented order', async () => {
  const context = await provisionDatabase();
  try {
    const roles = await context.db.query<{ rolname: string; rolcanlogin: boolean; rolconnlimit: number }>(
      `select rolname, rolcanlogin, rolconnlimit from pg_roles
        where rolname = any($1::text[]) order by rolname`,
      [[...RUNTIME_ROLES]],
    );
    assert.deepEqual(roles.rows.map((row) => row.rolname), ['szronox_api', 'szronox_worker']);
    // Login roles with bounded connection counts: a runaway pool cannot exhaust the
    // server's slots and lock the other process out.
    assert.deepEqual(roles.rows.map((row) => row.rolcanlogin), [true, true]);
    assert.equal(roles.rows[0].rolconnlimit, 10, 'szronox_api connection limit');
    assert.equal(roles.rows[1].rolconnlimit, 4, 'szronox_worker connection limit');

    // search_path is pinned, so a table planted in another schema cannot be resolved
    // ahead of the intended one.
    const settings = await context.db.query<{ rolname: string; rolconfig: string[] | null }>(
      `select rolname, rolconfig from pg_roles where rolname = any($1::text[]) order by rolname`,
      [[...RUNTIME_ROLES]],
    );
    for (const row of settings.rows) {
      assert.ok(
        (row.rolconfig ?? []).some((entry) => entry.startsWith('search_path=')),
        `${row.rolname} must have a pinned search_path`,
      );
    }

    // Rerunning grants.sql must be safe: it is the documented action after adding a
    // migration, and an operator who runs it twice must not get a different result.
    const grants = await readFile(path.join(deployDirectory, 'grants.sql'), 'utf8');
    const before = await Promise.all(RUNTIME_ROLES.map((role) => factsFor(context.db, role)));
    await context.raw.exec(grants);
    const after = await Promise.all(RUNTIME_ROLES.map((role) => factsFor(context.db, role)));
    assert.deepEqual(after, before, 'grants.sql must be idempotent');
  } finally {
    await context.close();
  }
});

// ══════════════════════ the grants satisfy the refusal rules ════════════════

test('grants.sql produces exactly the privileges the API startup check demands', async () => {
  const context = await provisionDatabase();
  try {
    const facts = await factsFor(context.db, 'szronox_api');

    // The production rule, not a restatement of it. An empty list is the only outcome
    // that lets the API start.
    assert.deepEqual(
      apiPrivilegeViolations(facts),
      [],
      `the API would refuse to start with these grants: ${JSON.stringify(facts.privileges)}`,
    );

    // The specific matrix, asserted separately so a failure names the wrong grant rather
    // than only reporting that the rule was unhappy.
    assert.deepEqual(facts.privileges['app.users'], { select: true, insert: false, update: false, delete: false },
      'the API reads the roster and cannot rewrite it');
    assert.deepEqual(facts.privileges['app.user_credentials'], { select: true, insert: false, update: false, delete: false },
      'the API verifies passwords and cannot set them');
    assert.deepEqual(facts.privileges['app.auth_sessions'], { select: true, insert: true, update: true, delete: true },
      'the API issues, resolves, revokes and prunes sessions');
    assert.deepEqual(facts.privileges['app.reels'], { select: true, insert: true, update: true, delete: true },
      'the API owns domain writes');

    assert.equal(facts.isSuperuser, false);
    assert.equal(facts.canCreateDb, false);
    assert.equal(facts.canCreateRole, false);
    assert.equal(facts.canCreateInAppSchema, false, 'the API cannot add objects to the application schema');
  } finally {
    await context.close();
  }
});

test('grants.sql produces exactly the privileges the worker startup check demands', async () => {
  const context = await provisionDatabase();
  try {
    const facts = await factsFor(context.db, 'szronox_worker');

    assert.deepEqual(
      workerPrivilegeViolations(facts),
      [],
      `the worker would refuse to start with these grants: ${JSON.stringify(facts.privileges)}`,
    );

    // The property that matters most: compromising background processing must not hand
    // over either account's login. Not even SELECT.
    assert.deepEqual(facts.privileges['app.user_credentials'], { select: false, insert: false, update: false, delete: false });
    assert.deepEqual(facts.privileges['app.auth_sessions'], { select: false, insert: false, update: false, delete: false });
    // Domain reads only. VPS-04 implements no worker write path, so granting one would be
    // granting it on faith.
    assert.deepEqual(facts.privileges['app.reels'], { select: true, insert: false, update: false, delete: false });
    assert.deepEqual(facts.privileges['app.users'], { select: true, insert: false, update: false, delete: false });

    assert.equal(facts.isSuperuser, false);
    assert.equal(facts.canCreateInAppSchema, false);
  } finally {
    await context.close();
  }
});

test('an over-privileged role is still caught, so the checks are not vacuous', async () => {
  // Without this, a `grants.sql` that granted everything would also pass the two tests
  // above if the refusal rules were themselves broken. Granting the API a write on the
  // credential table must make its own rule reject it.
  const context = await provisionDatabase();
  try {
    await context.raw.exec('grant update on app.user_credentials to szronox_api;');
    const facts = await factsFor(context.db, 'szronox_api');
    const violations = apiPrivilegeViolations(facts);
    assert.ok(
      violations.some((violation) => /write app\.user_credentials/.test(violation)),
      `expected a credential-write violation, got ${JSON.stringify(violations)}`,
    );

    await context.raw.exec('grant select on app.auth_sessions to szronox_worker;');
    const workerFacts = await factsFor(context.db, 'szronox_worker');
    assert.ok(
      workerPrivilegeViolations(workerFacts).some((violation) => /app\.auth_sessions/.test(violation)),
      'a worker that can read sessions must be refused',
    );
  } finally {
    await context.close();
  }
});

test('a table added by a later migration is unreachable until grants.sql is rerun', async () => {
  const context = await provisionDatabase();
  try {
    // What a future migration does. The default-privileges clause in grants.sql exists so
    // this table is not silently readable; the assertion is on the outcome, because that
    // is what a deployment actually depends on.
    await context.raw.exec('create table app.future_thing (id uuid primary key);');
    for (const role of RUNTIME_ROLES) {
      const grant = await context.db.query<{ s: boolean }>(
        `select pg_catalog.has_table_privilege($1, 'app.future_thing', 'SELECT') as s`,
        [role],
      );
      assert.equal(grant.rows[0].s, false, `${role} must not reach a new table before grants are reapplied`);
    }

    // And rerunning grants.sql does not accidentally grant it either: new tables must be
    // added to that file deliberately.
    await context.raw.exec(await readFile(path.join(deployDirectory, 'grants.sql'), 'utf8'));
    const afterRerun = await context.db.query<{ s: boolean }>(
      `select pg_catalog.has_table_privilege('szronox_api', 'app.future_thing', 'SELECT') as s`,
    );
    assert.equal(afterRerun.rows[0].s, false);
  } finally {
    await context.close();
  }
});

test('grants.sql names only objects the committed migrations create', async () => {
  // ON_ERROR_STOP makes the grants job abort on the first missing object, so a typo or a
  // table renamed by a later migration takes the whole deployment down. Executing the
  // file above already proves this — this test states the property explicitly and lists
  // what was covered, so the next person editing grants.sql knows what is checked.
  const grants = await readFile(path.join(deployDirectory, 'grants.sql'), 'utf8');
  const referenced = new Set(
    [...grants.matchAll(/\b(?:app|public)\.[a-z_]+/g)].map((match) => match[0]),
  );
  assert.ok(referenced.size > 0, 'the grants file must reference objects');

  const context = await provisionDatabase();
  try {
    for (const object of referenced) {
      const [schema, name] = object.split('.');
      const found = await context.db.query<{ count: number }>(
        `select count(*)::int as count from information_schema.tables
          where table_schema = $1 and table_name = $2`,
        [schema, name],
      );
      assert.equal(found.rows[0].count, 1, `grants.sql references ${object}, which does not exist`);
    }
  } finally {
    await context.close();
  }
});

test('neither runtime role can publish, edit or delete programme evidence', async () => {
  // The corpus is the only admissible source of programme evidence, so the ability to
  // write it is the ability to fabricate a citation. Both processes read; only the owner,
  // running the operator command, writes.
  const context = await provisionDatabase();
  const CORPUS_TABLES = [
    'app.programme_releases', 'app.programme_documents', 'app.programme_versions',
    'app.programme_release_versions', 'app.programme_vocabulary_entries',
    'app.programme_sections', 'app.programme_proposals', 'app.programme_chunks',
  ] as const;
  try {
    for (const role of RUNTIME_ROLES) {
      for (const table of CORPUS_TABLES) {
        const grant = await context.db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
          `select pg_catalog.has_table_privilege($1, $2, 'SELECT') as s,
                  pg_catalog.has_table_privilege($1, $2, 'INSERT') as i,
                  pg_catalog.has_table_privilege($1, $2, 'UPDATE') as u,
                  pg_catalog.has_table_privilege($1, $2, 'DELETE') as d`,
          [role, table],
        );
        assert.deepEqual(grant.rows[0], { s: true, i: false, u: false, d: false },
          `${role} must read ${table} and never write it`);
      }
    }
  } finally {
    await context.close();
  }
});

test('indexed programme content cannot be edited in place, even by the owner', async () => {
  // Immutability is what makes a pinned attachment trustworthy: a superseded release stays
  // readable precisely because nothing can rewrite the rows underneath it.
  const context = await provisionDatabase();
  try {
    const version = '05000000-0000-4000-8000-000000000001';
    const section = '05000000-0000-4000-8000-000000000002';
    const proposal = '05000000-0000-4000-8000-000000000003';
    const chunk = '05000000-0000-4000-8000-000000000004';
    await context.db.query(
      `insert into app.programme_versions (id, title, source_url, document_sha256)
       values ($1,'T','https://example.org/p.pdf',$2)`, [version, 'a'.repeat(64)]);
    await context.db.query(
      `insert into app.programme_sections
         (id, document_version_id, section_slug, chapter, subchapter, order_index, start_pdf_page, end_pdf_page)
       values ($1,$2,'sec-1','Rozdział',null,0,1,1)`, [section, version]);
    await context.db.query(
      `insert into app.programme_proposals
         (id, document_version_id, category, title, chapter, subchapter, search_text, section_id, external_id)
       values ($1,$2,'Kategoria','Postulat','Rozdział',null,'tekst',$3,'prop-1')`, [proposal, version, section]);
    await context.db.query(
      `insert into app.programme_chunks
         (id, proposal_id, excerpt, pdf_page, printed_page, document_version_id, section_id,
          external_id, order_index, char_start, char_end, pdf_pages, printed_pages)
       values ($1,$2,'Fragment',1,'1',$3,$4,'prop-1#000',0,0,8,$5,$6)`,
      [chunk, proposal, version, section, [1], ['1']]);

    await assert.rejects(
      context.db.query("update app.programme_chunks set excerpt='Podmieniony' where id=$1", [chunk]),
      /immutable/, 'chunk text must not be editable in place');
    await assert.rejects(
      context.db.query("update app.programme_proposals set title='Inny' where id=$1", [proposal]),
      /immutable/, 'a proposal title must not be editable in place');
    await assert.rejects(
      context.db.query('delete from app.programme_sections where id=$1', [section]),
      /immutable/, 'a section must not be deletable');
    await assert.rejects(
      context.db.query("update app.programme_versions set document_sha256=$2 where id=$1", [version, 'b'.repeat(64)]),
      /immutable/, 'the source hash anchors every citation and must not move');

    // A legacy version with no validated provenance can never join a release.
    const release = '05000000-0000-4000-8000-000000000005';
    await context.db.query(
      `insert into app.programme_releases
         (id, corpus_id, release_slug, label, category_vocabulary_id, imported_by, validation_report, coverage_ledger)
       values ($1,'corpus','release-1','Etykieta','vocab-1','NOXAVA','{}','{}')`, [release]);
    await assert.rejects(
      context.db.query(
        'insert into app.programme_release_versions (release_id, document_version_id, position) values ($1,$2,0)',
        [release, version]),
      /validated corpus provenance/);
  } finally {
    await context.close();
  }
});
