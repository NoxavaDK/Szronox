#!/bin/sh
# Create the two runtime login roles, once, when the data directory is initialised.
#
# Why here and not in a migration: roles and passwords are environment-specific, while
# `database/migrations/*.sql` is shared applied history that must be identical in every
# environment. A migration that created roles would also have to know their passwords.
#
# Why not the owner role for everything: the owner can rewrite the schema, the user
# roster and the credential table. The API needs none of that, and the worker needs far
# less again. Each process therefore logs in as its own role, and the API and worker
# refuse to start if they discover privileges they should not have.
#
# Passwords are read from mounted secret files and passed to psql as quoted variables.
# They never appear in a command-line argument, in this file, or in the log: psql's
# `:'name'` substitution quotes the value as a literal, and ON_ERROR_STOP makes a
# failure fatal rather than leaving a half-created role.
set -eu

api_password_file=${SZRONOX_API_DB_PASSWORD_FILE:-/run/secrets/api_db_password}
worker_password_file=${SZRONOX_WORKER_DB_PASSWORD_FILE:-/run/secrets/worker_db_password}

for file in "$api_password_file" "$worker_password_file"; do
  if [ ! -s "$file" ]; then
    echo "runtime role bootstrap failed: $file is missing or empty" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v api_password="$(cat "$api_password_file")" \
  -v dbname="$POSTGRES_DB" \
  -v worker_password="$(cat "$worker_password_file")" <<'SQL'
-- NOSUPERUSER/NOCREATEDB/NOCREATEROLE are spelled out rather than left to the default,
-- so a later PostgreSQL default change cannot widen these roles silently.
create role szronox_api  login password :'api_password'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 10;
create role szronox_worker login password :'worker_password'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 4;

-- Neither runtime role may create objects anywhere, including the public schema, which
-- by default allows CREATE to everyone on PostgreSQL versions before 15 and is revoked
-- here explicitly so the setting does not depend on the image's major version.
revoke all on schema public from public;
revoke create on schema public from public;

-- Pin the resolution order. Application SQL always schema-qualifies, so this is a
-- second line of defence: a function or table planted in another schema cannot be
-- picked up ahead of the intended one.
alter role szronox_api  set search_path = pg_catalog, app;
alter role szronox_worker set search_path = pg_catalog, app;

-- Connecting is not the same as reading. Grants on the tables themselves are applied by
-- the `grants` job after migrations create them; until then these roles can log in and
-- do nothing, which is the correct state for a database with no schema yet.
grant connect on database :"dbname" to szronox_api, szronox_worker;
SQL

echo "runtime roles szronox_api and szronox_worker created"
