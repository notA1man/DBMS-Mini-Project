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
-- Transactional outbox. Every state change that must reach Neo4j or MongoDB is written
-- here in the SAME transaction as the change itself; the dispatcher (src/lib/outbox)
-- claims rows with FOR UPDATE SKIP LOCKED, applies them idempotently and marks them done.
CREATE TABLE outbox_event (
  event_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate    text NOT NULL CHECK (aggregate ~ '^[a-z_]{2,30}$'),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 300),
  event_type   text NOT NULL CHECK (event_type ~ '^[A-Z_]{3,40}$'),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   text,
  next_attempt_at timestamptz NOT NULL DEFAULT now()   -- exponential backoff after failures
);
COMMENT ON TABLE outbox_event IS 'At-least-once delivery to MongoDB/Neo4j. Consumers must be idempotent (keyed by event_id).';
