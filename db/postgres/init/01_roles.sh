#!/bin/bash
# Least-privilege login role for the application (DML only, no DDL).
# Grants on tables are applied in 90_rls_grants.sql once the tables exist.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -v app_pw="$APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE skyops_app LOGIN PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skyops_app')\gexec
CREATE ROLE skyops_readonly NOLOGIN;
GRANT CONNECT ON DATABASE :"DBNAME" TO skyops_app, skyops_readonly;
GRANT USAGE ON SCHEMA public TO skyops_app, skyops_readonly;
SQL
