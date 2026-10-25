-- Extensions used across the schema
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: embeddings + HNSW
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints mixing = and &&
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy airport / name search
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- PII encryption, random PNRs
CREATE EXTENSION IF NOT EXISTS unaccent;    -- accent-insensitive full-text search
