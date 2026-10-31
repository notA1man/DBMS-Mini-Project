#!/bin/bash
# Least-privilege login role for the application (DML only, no DDL).
# Grants on tables are applied in 90_rls_grants.sql once the tables exist.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -v app_pw="$APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE strata_app LOGIN PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'strata_app')\gexec
CREATE ROLE strata_readonly NOLOGIN;
GRANT CONNECT ON DATABASE :"DBNAME" TO strata_app, strata_readonly;
GRANT USAGE ON SCHEMA public TO strata_app, strata_readonly;
SQL
