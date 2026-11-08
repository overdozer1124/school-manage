#!/bin/sh
# Creates the two application databases and one login role per database.
# Used by docker compose (as a docker-entrypoint-initdb.d script, running as
# the superuser) and by CI (run manually against the Postgres service).
# A role for one database gets no CONNECT privilege on the other database,
# so credentials cannot cross the platform / schedule boundary (8-3-2).
set -eu

: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD is required}"
: "${SCHEDULE_DB_PASSWORD:?SCHEDULE_DB_PASSWORD is required}"

psql_admin() {
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" "$@"
}

psql_admin <<SQL
CREATE ROLE platform_app LOGIN PASSWORD '${PLATFORM_DB_PASSWORD}';
CREATE ROLE schedule_app LOGIN PASSWORD '${SCHEDULE_DB_PASSWORD}';
CREATE DATABASE platform OWNER platform_app;
CREATE DATABASE schedule OWNER schedule_app;
REVOKE CONNECT ON DATABASE platform FROM PUBLIC;
REVOKE CONNECT ON DATABASE schedule FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO platform_app;
GRANT CONNECT ON DATABASE schedule TO schedule_app;
SQL
