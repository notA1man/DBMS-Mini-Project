-- 40_vector_kb.sql
-- Owner: Aiman
-- kb_document (+ fts), kb_chunk vector(384), feedback_embedding; HNSW cosine indexes
CREATE TABLE kb_document (
  doc_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  category text NOT NULL CHECK (category IN ('baggage','refund','check-in','assistance','pets','travel-docs')),
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE TABLE kb_chunk (
  chunk_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id bigint NOT NULL REFERENCES kb_document ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED,
  embedding vector(384) NOT NULL,
  UNIQUE (doc_id, chunk_index)
);
CREATE TABLE feedback_embedding (
  feedback_oid text PRIMARY KEY CHECK (feedback_oid ~ '^[0-9a-f]{24}$'),
  flight_id bigint NOT NULL REFERENCES flight ON DELETE CASCADE,
  sentiment text NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
  created_at timestamptz NOT NULL DEFAULT now(),
  embedding vector(384) NOT NULL
);
CREATE INDEX kb_chunk_embedding_hnsw ON kb_chunk USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX kb_chunk_fts_gin ON kb_chunk USING gin(fts);
CREATE INDEX feedback_embedding_hnsw ON feedback_embedding USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
