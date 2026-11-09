#!/bin/sh
# Creates the two application databases and one login role per database.
# Used by docker compose (as a docker-entrypoint-initdb.d script, running as
# the superuser) and by CI (run manually against the Postgres service).
# The platform_test database belongs to the platform role and is where
# the platform tests run (they rebuild the schema, so they must not
# touch the development database).
# A role for one database gets no CONNECT privilege on the other database,
# so credentials cannot cross the platform / schedule boundary (8-3-2).
# Passwords are passed as psql variables, never interpolated into the SQL
# text, so a password containing a quote cannot break the script.
set -eu

: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD is required}"
: "${SCHEDULE_DB_PASSWORD:?SCHEDULE_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" \
  -v platform_pw="$PLATFORM_DB_PASSWORD" \
  -v schedule_pw="$SCHEDULE_DB_PASSWORD" <<SQL
CREATE ROLE platform_app LOGIN PASSWORD :'platform_pw';
CREATE ROLE schedule_app LOGIN PASSWORD :'schedule_pw';
CREATE DATABASE platform OWNER platform_app;
CREATE DATABASE schedule OWNER schedule_app;
CREATE DATABASE platform_test OWNER platform_app;
CREATE DATABASE schedule_test OWNER schedule_app;
REVOKE CONNECT ON DATABASE platform FROM PUBLIC;
REVOKE CONNECT ON DATABASE schedule FROM PUBLIC;
REVOKE CONNECT ON DATABASE platform_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE schedule_test FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO platform_app;
GRANT CONNECT ON DATABASE schedule TO schedule_app;
GRANT CONNECT ON DATABASE platform_test TO platform_app;
GRANT CONNECT ON DATABASE schedule_test TO schedule_app;
SQL
