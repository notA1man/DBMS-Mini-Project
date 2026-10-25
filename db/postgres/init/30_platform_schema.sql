-- 30_platform_schema.sql
-- Owner: Aiman (app_user), Aditya (outbox_event)
-- app_user with role/link CHECKs; transactional outbox table
CREATE TABLE app_user (
  user_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email d_email NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN','OPS','CREW','PASSENGER')),
  passenger_id bigint UNIQUE REFERENCES passenger ON DELETE RESTRICT,
  crew_id bigint UNIQUE REFERENCES crew ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'PASSENGER') = (passenger_id IS NOT NULL)),
  CHECK ((role = 'CREW') = (crew_id IS NOT NULL))
);
ALTER TABLE booking ADD CONSTRAINT booking_created_by_user_fk
  FOREIGN KEY (created_by_user) REFERENCES app_user ON DELETE RESTRICT;

-- Identity-owned, persisted request budgets; no direct application table access.
CREATE TABLE auth_rate_limit (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  bucket_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts>0)
);

-- Aditya owns outbox_event. Its implementation belongs below this line.
