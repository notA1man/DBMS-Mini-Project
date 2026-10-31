#!/bin/bash
# Docker has just applied every ordered SQL file successfully. Record that baseline
# so db:migrate can skip those same files rather than attempting CREATE TABLE twice.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS strata_migration (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
for migration in /docker-entrypoint-initdb.d/*.sql; do
  # Do not baseline placeholders; another team member may implement them later.
  if ! sed 's/--.*//' "$migration" | grep -q '[^[:space:]]'; then continue; fi
  checksum=$(sed 's/\r$//' "$migration" | sha256sum | cut -d' ' -f1)
  name=$(basename "$migration")
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v name="$name" -v checksum="$checksum" <<'SQL'
INSERT INTO strata_migration(name,checksum) VALUES(:'name',:'checksum') ON CONFLICT(name) DO NOTHING;
SQL
done
